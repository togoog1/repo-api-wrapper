import { AttemptStatus, RunItemStatus, RunStatus } from "../generated/prisma/client.js";
import Bottleneck from "bottleneck";

import { getActionDefinition } from "../actions/index.js";
import type { ActionExecutionResult, BaseRunConfig } from "../actions/types.js";
import { getEnv } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logEvent(input: {
  runId: string;
  runSlug: string;
  moduleSlug: string;
  templateSlug?: string | null;
  runItemId?: string;
  level: string;
  eventType: string;
  message: string;
  data?: unknown;
}): Promise<void> {
  await prisma.eventLog.create({
    data: {
      runId: input.runId,
      runSlug: input.runSlug,
      moduleSlug: input.moduleSlug,
      templateSlug: input.templateSlug,
      runItemId: input.runItemId,
      level: input.level,
      eventType: input.eventType,
      message: input.message,
      data: input.data as never
    }
  });
}

async function refreshRunSummary(runId: string): Promise<void> {
  const [totalItems, succeededItems, failedItems, stoppedItems] = await Promise.all([
    prisma.runItem.count({ where: { runId } }),
    prisma.runItem.count({ where: { runId, status: RunItemStatus.SUCCEEDED } }),
    prisma.runItem.count({ where: { runId, status: RunItemStatus.FAILED } }),
    prisma.runItem.count({ where: { runId, status: RunItemStatus.STOPPED } })
  ]);

  await prisma.run.update({
    where: { id: runId },
    data: {
      totalItems,
      completedItems: succeededItems + failedItems + stoppedItems,
      succeededItems,
      failedItems
    }
  });
}

async function shouldStop(runId: string): Promise<boolean> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { stopRequestedAt: true }
  });

  return Boolean(run?.stopRequestedAt);
}

async function requestStop(runId: string, reason: string): Promise<void> {
  await prisma.run.update({
    where: { id: runId },
    data: {
      stopRequestedAt: new Date(),
      stopReason: reason
    }
  });
}

async function countConsecutiveFailures(runId: string): Promise<number> {
  const recentItems = await prisma.runItem.findMany({
    where: {
      runId,
      status: {
        in: [RunItemStatus.SUCCEEDED, RunItemStatus.FAILED]
      }
    },
    orderBy: {
      sequence: "desc"
    },
    take: 100,
    select: {
      status: true
    }
  });

  let consecutiveFailures = 0;

  for (const item of recentItems) {
    if (item.status !== RunItemStatus.FAILED) {
      break;
    }

    consecutiveFailures += 1;
  }

  return consecutiveFailures;
}

function createLimiter(config: BaseRunConfig): Bottleneck {
  if (config.maxRequestsPerMinute) {
    return new Bottleneck({
      maxConcurrent: config.concurrency,
      minTime: config.minDelayMs,
      reservoir: config.maxRequestsPerMinute,
      reservoirRefreshAmount: config.maxRequestsPerMinute,
      reservoirRefreshInterval: 60_000
    });
  }

  return new Bottleneck({
    maxConcurrent: config.concurrency,
    minTime: config.minDelayMs
  });
}

async function completeItem(input: {
  runId: string;
  runItemId: string;
  status: RunItemStatus;
  request?: unknown;
  response?: unknown;
  lastHttpStatus?: number;
  lastError?: string;
}): Promise<void> {
  await prisma.runItem.update({
    where: { id: input.runItemId },
    data: {
      status: input.status,
      request: input.request as never,
      response: input.response as never,
      lastHttpStatus: input.lastHttpStatus,
      lastError: input.lastError,
      finishedAt: new Date()
    }
  });

  await refreshRunSummary(input.runId);
}

async function recordAttempt(input: {
  runId: string;
  runItemId: string;
  attemptNumber: number;
  result: ActionExecutionResult;
  durationMs: number;
}): Promise<void> {
  await prisma.attempt.create({
    data: {
      runId: input.runId,
      runItemId: input.runItemId,
      attemptNumber: input.attemptNumber,
      status: input.result.ok ? AttemptStatus.SUCCEEDED : AttemptStatus.FAILED,
      httpStatus: input.result.httpStatus,
      durationMs: input.durationMs,
      request: input.result.request as never,
      response: input.result.response as never,
      error: input.result.error
    }
  });
}

async function processRunItem(
  runMeta: {
    id: string;
    slug: string;
    moduleSlug: string;
    templateSlug?: string | null;
  },
  actionName: string,
  runItemId: string,
  masterId: number,
  config: BaseRunConfig,
  limiter: Bottleneck
): Promise<void> {
  if (await shouldStop(runMeta.id)) {
    await completeItem({
      runId: runMeta.id,
      runItemId,
      status: RunItemStatus.STOPPED,
      lastError: "Skipped because the run was stopped before execution."
    });
    return;
  }

  const env = getEnv(runMeta.moduleSlug);
  const action = getActionDefinition(actionName);

  await prisma.runItem.update({
    where: { id: runItemId },
    data: {
      status: RunItemStatus.RUNNING,
      startedAt: new Date()
    }
  });

  await logEvent({
    runId: runMeta.id,
    runSlug: runMeta.slug,
    moduleSlug: runMeta.moduleSlug,
    templateSlug: runMeta.templateSlug,
    runItemId,
    level: "info",
    eventType: "item.started",
    message: `Started master_id ${masterId}`
  });

  for (let attemptNumber = 1; attemptNumber <= config.maxRetries + 1; attemptNumber += 1) {
    if (attemptNumber > 1) {
      await sleep(config.retryDelayMs * (attemptNumber - 1));
    }

    if (await shouldStop(runMeta.id)) {
      await completeItem({
        runId: runMeta.id,
        runItemId,
        status: RunItemStatus.STOPPED,
        lastError: "Stopped before the next attempt."
      });
      return;
    }

    const startedAt = Date.now();
    let result: ActionExecutionResult;
    try {
      result = await limiter.schedule(() =>
        action.execute({
          masterId,
          config,
          env,
          logger
        })
      );
    } catch (execError) {
      const errorMessage =
        execError instanceof Error ? execError.message : "Unexpected execution error";

      await recordAttempt({
        runId: runMeta.id,
        runItemId,
        attemptNumber,
        result: {
          ok: false,
          httpStatus: undefined,
          request: {},
          response: undefined,
          error: errorMessage,
          retryable: false
        },
        durationMs: Date.now() - startedAt
      });

      await completeItem({
        runId: runMeta.id,
        runItemId,
        status: RunItemStatus.FAILED,
        lastError: errorMessage
      });

      await logEvent({
        runId: runMeta.id,
        runSlug: runMeta.slug,
        moduleSlug: runMeta.moduleSlug,
        templateSlug: runMeta.templateSlug,
        runItemId,
        level: "error",
        eventType: "item.failed",
        message: `Failed for master_id ${masterId}: ${errorMessage}`,
        data: { attemptNumber, error: errorMessage }
      });

      return;
    }

    await prisma.runItem.update({
      where: { id: runItemId },
      data: {
        attemptCount: attemptNumber,
        lastHttpStatus: result.httpStatus,
        lastError: result.error,
        request: result.request as never,
        response: result.response as never
      }
    });

    await recordAttempt({
      runId: runMeta.id,
      runItemId,
      attemptNumber,
      result,
      durationMs: Date.now() - startedAt
    });

    if (result.ok) {
      await completeItem({
        runId: runMeta.id,
        runItemId,
        status: RunItemStatus.SUCCEEDED,
        request: result.request,
        response: result.response,
        lastHttpStatus: result.httpStatus
      });

      await logEvent({
        runId: runMeta.id,
        runSlug: runMeta.slug,
        moduleSlug: runMeta.moduleSlug,
        templateSlug: runMeta.templateSlug,
        runItemId,
        level: "info",
        eventType: "item.succeeded",
        message: `Succeeded for master_id ${masterId}`,
        data: {
          httpStatus: result.httpStatus,
          attemptNumber
        }
      });

      return;
    }

    const shouldRetry = result.retryable && attemptNumber <= config.maxRetries;

    if (!shouldRetry) {
      await completeItem({
        runId: runMeta.id,
        runItemId,
        status: RunItemStatus.FAILED,
        request: result.request,
        response: result.response,
        lastHttpStatus: result.httpStatus,
        lastError: result.error
      });

      await logEvent({
        runId: runMeta.id,
        runSlug: runMeta.slug,
        moduleSlug: runMeta.moduleSlug,
        templateSlug: runMeta.templateSlug,
        runItemId,
        level: "error",
        eventType: "item.failed",
        message: `Failed for master_id ${masterId}`,
        data: {
          httpStatus: result.httpStatus,
          attemptNumber,
          error: result.error
        }
      });

      if (
        config.stopOnHttpStatuses.includes(result.httpStatus ?? 0) ||
        (config.stopAfterFailures &&
          (await prisma.runItem.count({
            where: {
              runId: runMeta.id,
              status: RunItemStatus.FAILED
            }
          })) >= config.stopAfterFailures)
        ||
        (config.stopAfterConsecutiveFailures &&
          (await countConsecutiveFailures(runMeta.id)) >=
            config.stopAfterConsecutiveFailures)
      ) {
        await requestStop(runMeta.id, "Exit condition reached.");
      }

      return;
    }

    await logEvent({
      runId: runMeta.id,
      runSlug: runMeta.slug,
      moduleSlug: runMeta.moduleSlug,
      templateSlug: runMeta.templateSlug,
      runItemId,
      level: "warn",
      eventType: "item.retrying",
      message: `Retrying master_id ${masterId}`,
      data: {
        httpStatus: result.httpStatus,
        attemptNumber,
        error: result.error
      }
    });
  }
}

export async function executeRun(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId }
  });

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const action = getActionDefinition(run.action);
  const config = action.configSchema.parse(run.config);
  const runSlug = run.slug ?? run.id;
  const moduleSlug = run.moduleSlug ?? run.action;
  const templateSlug = run.templateSlug;

  await prisma.$transaction([
    prisma.run.update({
      where: { id: runId },
      data: {
        status: RunStatus.RUNNING,
        startedAt: run.startedAt ?? new Date(),
        finishedAt: null,
        lastError: null,
        stopRequestedAt: null,
        stopReason: null
      }
    }),
    prisma.runItem.updateMany({
      where: {
        runId,
        status: RunItemStatus.RUNNING
      },
      data: {
        status: RunItemStatus.PENDING
      }
    })
  ]);

  await logEvent({
    runId,
    runSlug,
    moduleSlug,
    templateSlug,
    level: "info",
    eventType: "run.started",
    message: `Run ${runId} started`
  });

  const pendingItems = await prisma.runItem.findMany({
    where: {
      runId,
      status: RunItemStatus.PENDING
    },
    orderBy: {
      sequence: "asc"
    },
    select: {
      id: true,
      masterId: true
    }
  });

  const limiter = createLimiter(config);

  try {
    await Promise.all(
      pendingItems.map((item) =>
        processRunItem(
          {
            id: runId,
            slug: runSlug,
            moduleSlug,
            templateSlug
          },
          run.action,
          item.id,
          item.masterId,
          config,
          limiter
        )
      )
    );

    await refreshRunSummary(runId);

    const [remainingItems, stopState] = await Promise.all([
      prisma.runItem.count({
        where: {
          runId,
          status: {
            in: [RunItemStatus.PENDING, RunItemStatus.RUNNING]
          }
        }
      }),
      prisma.run.findUnique({
        where: { id: runId },
        select: { stopRequestedAt: true, stopReason: true }
      })
    ]);

    const status = stopState?.stopRequestedAt ? RunStatus.STOPPED : RunStatus.COMPLETED;

    await prisma.run.update({
      where: { id: runId },
      data: {
        status: remainingItems === 0 ? status : RunStatus.STOPPED,
        finishedAt: new Date(),
        stopReason: remainingItems === 0 ? stopState?.stopReason : stopState?.stopReason ?? "Run stopped with pending items"
      }
    });

    await logEvent({
      runId,
      runSlug,
      moduleSlug,
      templateSlug,
      level: "info",
      eventType: "run.finished",
      message:
        remainingItems === 0
          ? `Run ${runId} finished`
          : `Run ${runId} stopped with pending items`,
      data: {
        status,
        stopReason: stopState?.stopReason
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown run failure";

    await prisma.run.update({
      where: { id: runId },
      data: {
        status: RunStatus.FAILED,
        finishedAt: new Date(),
        lastError: message
      }
    });

    await logEvent({
      runId,
      runSlug,
      moduleSlug,
      templateSlug,
      level: "error",
      eventType: "run.failed",
      message,
      data: {
        error: message
      }
    });

    throw error;
  }
}
