import type { ActionDefinition, BaseRunConfig } from "./types.js";
import {
  syncOnboardingAction,
  type SyncOnboardingRunConfig
} from "./sync-onboarding.js";

const actionDefinitions = {
  "sync-onboarding": syncOnboardingAction
} as const;

export type ActionName = keyof typeof actionDefinitions;
export type KnownRunConfig = SyncOnboardingRunConfig;

export function getActionDefinition(action: string): ActionDefinition<BaseRunConfig> {
  const definition = actionDefinitions[action as ActionName];

  if (!definition) {
    throw new Error(`Unsupported action: ${action}`);
  }

  return definition as ActionDefinition<BaseRunConfig>;
}
