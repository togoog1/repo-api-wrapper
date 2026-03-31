import { RunItemStatus, RunStatus } from "../generated/prisma/client.js";

import { getModuleEndpoint, getSupportedModule } from "../config/services.js";
import {
  httpRequestInputSchema,
  type HttpRequestInput
} from "../actions/parse-http-request-input.js";
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

async function resolveItemValues(input: {
  itemValues?: string[];
  inputListId?: string;
}): Promise<{
  itemValues: string[];
  inputListId?: string;
}> {
  if (input.itemValues && input.itemValues.length > 0) {
    return {
      itemValues: input.itemValues,
      inputListId: input.inputListId
    };
  }

  if (!input.inputListId) {
    // No IDs and no list — endpoint has no path token, run once
    return { itemValues: ["0"] };
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
  const itemValues = rawValues.map((value) => {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
    throw new Error("Selected input list contains invalid values.");
  });

  return {
    itemValues,
    inputListId: inputList.id
  };
}

export async function createHttpRequestRun(
  input: HttpRequestInput & {
    moduleSlug?: string;
    endpointSlug?: string;
    inputListId?: string;
    disabledDefaultHeaders?: string[];
  }
): Promise<string> {
  const moduleDefinition = getSupportedModule(input.moduleSlug);
  const endpointDefinition = getModuleEndpoint(moduleDefinition, input.endpointSlug);
  const resolvedInput = await resolveItemValues({
    itemValues: input.itemValues,
    inputListId: input.inputListId
  });

  // Merge default headers: module → endpoint → user (highest priority)
  const moduleDefaultHeaders = moduleDefinition.defaultHeaders ?? {};
  const epDefaultHeaders = endpointDefinition.defaultHeaders ?? {};
  const epConfigHeaders = (
    endpointDefinition.defaultRunConfig?.headers &&
    typeof endpointDefinition.defaultRunConfig.headers === "object" &&
    !Array.isArray(endpointDefinition.defaultRunConfig.headers)
  ) ? endpointDefinition.defaultRunConfig.headers as Record<string, string> : {};
  const userHeaders = input.headers ?? {};
  const disabledKeys = new Set(input.disabledDefaultHeaders ?? []);

  const mergedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(moduleDefaultHeaders)) {
    if (!disabledKeys.has(k)) mergedHeaders[k] = v;
  }
  for (const [k, v] of Object.entries({ ...epDefaultHeaders, ...epConfigHeaders })) {
    if (!disabledKeys.has(k)) mergedHeaders[k] = v;
  }
  for (const [k, v] of Object.entries(userHeaders)) {
    mergedHeaders[k] = v;
  }

  const parsed = httpRequestInputSchema.parse({
    ...endpointDefinition.defaultRunConfig,
    ...input,
    headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
    itemValues: resolvedInput.itemValues,
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
        totalItems: config.itemValues.length
      }
    });

    await tx.runItem.createMany({
      data: config.itemValues.map((itemValue, index) => ({
        runId: createdRun.id,
        sequence: index + 1,
        itemValue
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
          itemCount: config.itemValues.length,
          serviceName: createdRun.serviceName,
          moduleSlug: createdRun.moduleSlug
        } as never
      }
    });

    return createdRun;
  });

  return run.id;
}

export async function createAndStartHttpRequestRun(
  input: HttpRequestInput & {
    moduleSlug?: string;
    endpointSlug?: string;
    inputListId?: string;
    disabledDefaultHeaders?: string[];
  }
): Promise<string> {
  const runId = await createHttpRequestRun(input);
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
        itemValue: true
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

  return createAndStartHttpRequestRun({
    moduleSlug: run.moduleSlug ?? undefined,
    endpointSlug: typeof config.endpointSlug === "string" ? config.endpointSlug : undefined,
    label: `${run.label ?? "run"} failures`,
    itemValues: failedItems.map((item) => item.itemValue).filter((id) => id !== "0"),
    targetEnvironment: config.targetEnvironment as HttpRequestInput["targetEnvironment"],
    method: (typeof config.method === "string" ? config.method : "POST") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    bodyType: (typeof config.bodyType === "string" ? config.bodyType : "json") as "none" | "json" | "form" | "text" | "multipart",
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
      : [],
    skipAuth: typeof config.skipAuth === "boolean" ? config.skipAuth : false,
    timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
    followRedirects: typeof config.followRedirects === "boolean" ? config.followRedirects : true,
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
        itemValue: true,
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
      itemValue: true,
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

export async function exportRunResults(runId: string, format: "json" | "csv") {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, label: true, moduleSlug: true, status: true, config: true }
  });
  if (!run) throw new Error(`Run not found: ${runId}`);

  const items = await prisma.runItem.findMany({
    where: { runId },
    orderBy: { sequence: "asc" },
    select: {
      sequence: true,
      itemValue: true,
      status: true,
      attemptCount: true,
      lastHttpStatus: true,
      lastError: true,
      request: true,
      response: true,
      startedAt: true,
      finishedAt: true
    }
  });

  if (format === "csv") {
    const header = "sequence,itemValue,status,httpStatus,attemptCount,error,startedAt,finishedAt";
    const rows = items.map((item) => {
      const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
      return [
        item.sequence,
        escape(item.itemValue),
        item.status,
        item.lastHttpStatus ?? "",
        item.attemptCount,
        escape(item.lastError ?? ""),
        item.startedAt ?? "",
        item.finishedAt ?? ""
      ].join(",");
    });
    return { contentType: "text/csv", body: [header, ...rows].join("\n"), filename: `${run.label ?? run.id}.csv` };
  }

  return {
    contentType: "application/json",
    body: JSON.stringify({ run: { id: run.id, label: run.label, status: run.status, moduleSlug: run.moduleSlug }, items }, null, 2),
    filename: `${run.label ?? run.id}.json`
  };
}
