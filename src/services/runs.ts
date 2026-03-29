import { RunItemStatus, RunStatus } from "../generated/prisma/client.js";

import { getModuleEndpoint, getSupportedModule } from "../config/services.js";
import {
  syncOnboardingInputSchema,
  type SyncOnboardingInput
} from "../actions/parse-sync-onboarding-input.js";
import { createRunSlug } from "../lib/slug.js";
import { prisma } from "../lib/prisma.js";
import { startRunInBackground } from "../runner/background-runs.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function asObject(value: unknown): Record<string, JsonValue> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, JsonValue>;
  }

  return {};
}

function createRunLabel(action: string, input?: string): string {
  if (input) {
    return input;
  }

  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `${action} ${timestamp}`;
}

async function resolveMasterIds(input: {
  masterIds?: number[];
  inputListId?: string;
}): Promise<{
  masterIds: number[];
  inputListId?: string;
}> {
  if (input.masterIds && input.masterIds.length > 0) {
    return {
      masterIds: input.masterIds,
      inputListId: input.inputListId
    };
  }

  if (!input.inputListId) {
    throw new Error("Provide master IDs directly or select a saved input list.");
  }

  const inputList = await prisma.savedInputList.findUnique({
    where: { id: input.inputListId },
    select: {
      id: true,
      data: true
    }
  });

  if (!inputList) {
    throw new Error(`Input list not found: ${input.inputListId}`);
  }

  const rawValues = Array.isArray(inputList.data) ? inputList.data : [];
  const masterIds = rawValues.map((value) => {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);

      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }

    throw new Error("Selected input list contains non-master-id values.");
  });

  return {
    masterIds,
    inputListId: inputList.id
  };
}

export async function createSyncOnboardingRun(
  input: SyncOnboardingInput & {
    moduleSlug?: string;
    endpointSlug?: string;
    inputListId?: string;
  }
): Promise<string> {
  const moduleDefinition = getSupportedModule(input.moduleSlug);
  const endpointDefinition = getModuleEndpoint(moduleDefinition, input.endpointSlug);
  const resolvedInput = await resolveMasterIds({
    masterIds: input.masterIds,
    inputListId: input.inputListId
  });
  const parsed = syncOnboardingInputSchema.parse({
    ...endpointDefinition.defaultRunConfig,
    ...input,
    masterIds: resolvedInput.masterIds,
    endpointSlug: input.endpointSlug ?? endpointDefinition.slug,
    targetEnvironment: input.targetEnvironment ?? moduleDefinition.defaultTargetEnvironment,
    pathTemplate: input.pathTemplate ?? endpointDefinition.pathTemplate
  });
  const { label, ...config } = parsed;
  const runSlug = createRunSlug(moduleDefinition.slug);

  const run = await prisma.$transaction(async (tx) => {
    const createdRun = await tx.run.create({
      data: {
        slug: runSlug,
        label: createRunLabel(
          endpointDefinition.defaultRunLabel ?? moduleDefinition.label,
          label
        ),
        serviceName: moduleDefinition.serviceName,
        action: endpointDefinition.action,
        moduleSlug: moduleDefinition.slug,
        inputListId: resolvedInput.inputListId,
        config: config as never,
        totalItems: config.masterIds.length
      }
    });

    await tx.runItem.createMany({
      data: config.masterIds.map((masterId, index) => ({
        runId: createdRun.id,
        sequence: index + 1,
        masterId
      }))
    });

    await tx.eventLog.create({
      data: {
        runId: createdRun.id,
        runSlug: createdRun.slug,
        moduleSlug: createdRun.moduleSlug,
        level: "info",
        eventType: "run.created",
        message: `Created run ${createdRun.label ?? createdRun.id}`,
        data: {
          itemCount: config.masterIds.length,
          serviceName: createdRun.serviceName,
          moduleSlug: createdRun.moduleSlug
        } as never
      }
    });

    return createdRun;
  });

  return run.id;
}

export async function createAndStartSyncOnboardingRun(
  input: SyncOnboardingInput & {
    moduleSlug?: string;
    endpointSlug?: string;
    inputListId?: string;
  }
): Promise<string> {
  const runId = await createSyncOnboardingRun(input);
  startRunInBackground(runId);
  return runId;
}

export async function createRetryRunFromFailures(runId: string): Promise<string> {
  const [run, failedItems] = await Promise.all([
    prisma.run.findUnique({
      where: { id: runId },
      select: {
        id: true,
        label: true,
        moduleSlug: true,
        config: true
      }
    }),
    prisma.runItem.findMany({
      where: {
        runId,
        status: RunItemStatus.FAILED
      },
      orderBy: {
        sequence: "asc"
      },
      select: {
        masterId: true
      }
    })
  ]);

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  if (failedItems.length === 0) {
    throw new Error("Run has no failed items to retry.");
  }

  const config = asObject(run.config);

  return createAndStartSyncOnboardingRun({
    moduleSlug: run.moduleSlug ?? undefined,
    endpointSlug: typeof config.endpointSlug === "string" ? config.endpointSlug : undefined,
    label: `${run.label ?? "run"} failures`,
    masterIds: failedItems.map((item) => item.masterId),
    targetEnvironment: config.targetEnvironment as SyncOnboardingInput["targetEnvironment"],
    pathTemplate: typeof config.pathTemplate === "string" ? config.pathTemplate : undefined,
    dryRun: typeof config.dryRun === "boolean" ? config.dryRun : false,
    concurrency: typeof config.concurrency === "number" ? config.concurrency : 1,
    minDelayMs: typeof config.minDelayMs === "number" ? config.minDelayMs : 0,
    maxRequestsPerMinute:
      typeof config.maxRequestsPerMinute === "number" ? config.maxRequestsPerMinute : undefined,
    maxRetries: typeof config.maxRetries === "number" ? config.maxRetries : 0,
    retryDelayMs: typeof config.retryDelayMs === "number" ? config.retryDelayMs : 1000,
    stopAfterFailures:
      typeof config.stopAfterFailures === "number" ? config.stopAfterFailures : undefined,
    stopAfterConsecutiveFailures:
      typeof config.stopAfterConsecutiveFailures === "number"
        ? config.stopAfterConsecutiveFailures
        : undefined,
    stopOnHttpStatuses: Array.isArray(config.stopOnHttpStatuses)
      ? config.stopOnHttpStatuses.filter((value): value is number => typeof value === "number")
      : []
  });
}

export async function stopRun(runId: string, reason: string): Promise<void> {
  await prisma.run.update({
    where: { id: runId },
    data: {
      stopRequestedAt: new Date(),
      stopReason: reason,
      status: RunStatus.STOPPED
    }
  });
}

export async function resumeRun(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true
    }
  });

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  if (run.status === RunStatus.RUNNING) {
    return;
  }

  await prisma.run.update({
    where: { id: runId },
    data: {
      status: RunStatus.PENDING
    }
  });

  startRunInBackground(runId);
}

export async function listRuns(limit = 24) {
  return prisma.run.findMany({
    orderBy: {
      createdAt: "desc"
    },
    take: limit,
    select: {
      id: true,
      slug: true,
      label: true,
      serviceName: true,
      action: true,
      moduleSlug: true,
      templateSlug: true,
      inputListId: true,
      status: true,
      totalItems: true,
      completedItems: true,
      succeededItems: true,
      failedItems: true,
      stopReason: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true
    }
  });
}

export async function getRunOverview(runId: string) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      slug: true,
      label: true,
      serviceName: true,
      action: true,
      moduleSlug: true,
      templateSlug: true,
      inputListId: true,
      status: true,
      config: true,
      totalItems: true,
      completedItems: true,
      succeededItems: true,
      failedItems: true,
      stopRequestedAt: true,
      stopReason: true,
      startedAt: true,
      finishedAt: true,
      lastError: true,
      createdAt: true,
      updatedAt: true
    }
  });

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const [statusBreakdown, recentFailures, recentEvents] = await Promise.all([
    prisma.runItem.groupBy({
      by: ["status"],
      where: { runId },
      _count: true
    }),
    prisma.runItem.findMany({
      where: {
        runId,
        status: RunItemStatus.FAILED
      },
      orderBy: {
        sequence: "asc"
      },
      take: 12,
      select: {
        id: true,
        sequence: true,
        masterId: true,
        attemptCount: true,
        lastHttpStatus: true,
        lastError: true,
        finishedAt: true
      }
    }),
    prisma.eventLog.findMany({
      where: { runId },
      orderBy: {
        createdAt: "desc"
      },
      take: 16,
      select: {
        id: true,
        runItemId: true,
        level: true,
        eventType: true,
        message: true,
        data: true,
        createdAt: true
      }
    })
  ]);

  return {
    ...run,
    config: asObject(run.config),
    itemStatusBreakdown: statusBreakdown.map((entry) => ({
      status: entry.status,
      count: entry._count
    })),
    recentFailures,
    recentEvents
  };
}

export async function listRunItems(input: {
  runId: string;
  status?: RunItemStatus;
}) {
  return prisma.runItem.findMany({
    where: {
      runId: input.runId,
      status: input.status
    },
    orderBy: {
      sequence: "asc"
    },
    select: {
      id: true,
      sequence: true,
      masterId: true,
      status: true,
      attemptCount: true,
      lastHttpStatus: true,
      lastError: true,
      request: true,
      startedAt: true,
      finishedAt: true,
      response: true
    }
  });
}

export async function listRunEvents(runId: string, limit = 80) {
  return prisma.eventLog.findMany({
    where: { runId },
    orderBy: {
      createdAt: "desc"
    },
    take: limit,
    select: {
      id: true,
      runItemId: true,
      level: true,
      eventType: true,
      message: true,
      data: true,
      createdAt: true
    }
  });
}
