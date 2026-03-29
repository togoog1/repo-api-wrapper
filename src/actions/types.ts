import type { Logger } from "pino";

import type { EnvConfig } from "../lib/env.js";
import type { TargetEnvironment } from "../lib/target-environment.js";

export interface BaseRunConfig {
  endpointSlug?: string;
  masterIds: number[];
  targetEnvironment: TargetEnvironment;
  pathTemplate: string;
  concurrency: number;
  minDelayMs: number;
  maxRequestsPerMinute?: number;
  maxRetries: number;
  retryDelayMs: number;
  stopAfterFailures?: number;
  stopAfterConsecutiveFailures?: number;
  stopOnHttpStatuses: number[];
}

export interface ActionExecutionResult {
  ok: boolean;
  httpStatus?: number;
  request: Record<string, unknown>;
  response: unknown;
  error?: string;
  retryable: boolean;
}

export interface ExecuteActionInput<TConfig extends BaseRunConfig> {
  masterId: number;
  config: TConfig;
  env: EnvConfig;
  logger: Logger;
}

export interface ActionDefinition<TConfig extends BaseRunConfig> {
  name: string;
  configSchema: {
    parse(input: unknown): TConfig;
  };
  execute(input: ExecuteActionInput<TConfig>): Promise<ActionExecutionResult>;
}
