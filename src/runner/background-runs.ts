import { logger } from "../lib/logger.js";
import { executeRun } from "./execute-run.js";

const activeRuns = new Map<string, Promise<void>>();

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

export function startRunInBackground(runId: string): boolean {
  if (activeRuns.has(runId)) {
    return false;
  }

  const task = executeRun(runId)
    .catch((error) => {
      logger.error(
        {
          err: error,
          runId
        },
        "Background run failed"
      );
    })
    .finally(() => {
      activeRuns.delete(runId);
    });

  activeRuns.set(runId, task);
  return true;
}
