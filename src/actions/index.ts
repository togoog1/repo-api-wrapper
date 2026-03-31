import type { ActionDefinition, BaseRunConfig } from "./types.js";
import { httpRequestAction, type HttpRequestRunConfig } from "./http-request.js";

const actionDefinitions: Record<string, ActionDefinition<BaseRunConfig>> = {
  "http-request": httpRequestAction,
  // Legacy alias for runs created before the rename
  "sync-onboarding": httpRequestAction
};

export type KnownRunConfig = HttpRequestRunConfig;

export function getActionDefinition(action: string): ActionDefinition<BaseRunConfig> {
  const definition = actionDefinitions[action];

  if (!definition) {
    throw new Error(`Unsupported action: ${action}`);
  }

  return definition;
}
