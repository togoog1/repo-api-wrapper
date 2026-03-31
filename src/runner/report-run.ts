import { RunItemStatus } from "../generated/prisma/client.js";

import { prisma } from "../lib/prisma.js";

export async function printRunReport(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId }
  });

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const failedItems = await prisma.runItem.findMany({
    where: {
      runId,
      status: RunItemStatus.FAILED
    },
    orderBy: {
      sequence: "asc"
    },
    select: {
      sequence: true,
      itemValue: true,
      attemptCount: true,
      lastHttpStatus: true,
      lastError: true
    }
  });

  console.log(JSON.stringify({
    id: run.id,
    action: run.action,
    status: run.status,
    totalItems: run.totalItems,
    completedItems: run.completedItems,
    succeededItems: run.succeededItems,
    failedItems: run.failedItems,
    stopRequestedAt: run.stopRequestedAt,
    stopReason: run.stopReason,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    failures: failedItems
  }, null, 2));
}
