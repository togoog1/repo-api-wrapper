import { z } from "zod";

import { targetEnvironmentSchema } from "../lib/target-environment.js";
import { buildRequestUrl, hasMasterIdToken, normalizePathTemplate } from "./url-template.js";
import type { ActionDefinition } from "./types.js";

const responseBodySchema = z.object({
  dry_run: z.boolean().default(false)
});

export const syncOnboardingConfigSchema = z.object({
  endpointSlug: z.string().trim().min(1).optional(),
  masterIds: z.array(z.number().int().positive()).min(1),
  targetEnvironment: targetEnvironmentSchema,
  pathTemplate: z
    .string()
    .trim()
    .min(1)
    .transform(normalizePathTemplate)
    .refine(hasMasterIdToken, {
      message: "Path template must include :master_id or {master_id}"
    })
    .default("/sync-onboarding/:master_id"),
  dryRun: z.boolean().default(false),
  concurrency: z.number().int().positive().default(1),
  minDelayMs: z.number().int().min(0).default(0),
  maxRequestsPerMinute: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).default(0),
  retryDelayMs: z.number().int().min(0).default(1_000),
  stopAfterFailures: z.number().int().positive().optional(),
  stopAfterConsecutiveFailures: z.number().int().positive().optional(),
  stopOnHttpStatuses: z.array(z.number().int().min(100).max(599)).default([])
});

export type SyncOnboardingRunConfig = z.infer<typeof syncOnboardingConfigSchema>;

export const syncOnboardingAction: ActionDefinition<SyncOnboardingRunConfig> = {
  name: "sync-onboarding",
  configSchema: syncOnboardingConfigSchema,
  async execute({ masterId, config, env }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.apiTimeoutMs);
    const apiBaseUrl = env.resolveApiBaseUrl(config.targetEnvironment);
    const apiBearerToken = await env.getApiBearerToken(config.targetEnvironment);
    const payload = responseBodySchema.parse({
      dry_run: config.dryRun
    });
    const endpoint = buildRequestUrl(apiBaseUrl, config.pathTemplate, masterId);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiBearerToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") ?? "";
      const parsedBody =
        contentType.includes("application/json")
          ? await response.json()
          : await response.text();

      return {
        ok: response.ok,
        httpStatus: response.status,
        request: {
          method: "POST",
          url: endpoint.toString(),
          body: payload,
          targetEnvironment: config.targetEnvironment,
          pathTemplate: config.pathTemplate,
          authMode: env.authMode
        },
        response: parsedBody,
        error: response.ok ? undefined : `HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown request error";

      return {
        ok: false,
        request: {
          method: "POST",
          url: endpoint.toString(),
          body: payload,
          targetEnvironment: config.targetEnvironment,
          pathTemplate: config.pathTemplate,
          authMode: env.authMode
        },
        response: null,
        error: message,
        retryable: true
      };
    } finally {
      clearTimeout(timeout);
    }
  }
};
