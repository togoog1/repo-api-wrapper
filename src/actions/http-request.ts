import { z } from "zod";

import { targetEnvironmentSchema } from "../lib/target-environment.js";
import { buildRequestUrl, normalizePathTemplate } from "./url-template.js";
import type { ActionDefinition } from "./types.js";

const dryRunBodySchema = z.object({
  dry_run: z.boolean().default(false)
});

export const httpRequestConfigSchema = z.object({
  endpointSlug: z.string().trim().min(1).optional(),
  itemValues: z.array(z.string().min(1)).default([]),
  targetEnvironment: targetEnvironmentSchema,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  pathTemplate: z
    .string()
    .trim()
    .min(1)
    .transform(normalizePathTemplate)
    .default("/:id"),
  queryParams: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bodyType: z.enum(["none", "json", "form", "text", "multipart"]).default("json"),
  requestBody: z.record(z.string(), z.unknown()).nullish(),
  formBody: z.record(z.string(), z.string()).optional(),
  requestBodyText: z.string().optional(),
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

export type HttpRequestRunConfig = z.infer<typeof httpRequestConfigSchema>;

function interpolateTemplate(template: string, itemValue: string): string {
  // For multi-token items (JSON object), also substitute {{tokenName}}
  try {
    const parsed = JSON.parse(itemValue) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const valueMap = parsed as Record<string, string>;
      // Replace {{tokenName}} for each key, and {{itemValue}} with first value
      const firstValue = Object.values(valueMap)[0] ?? itemValue;
      return template
        .replace(/\{\{itemValue\}\}/gu, firstValue)
        .replace(/\{\{([a-z][a-z0-9_]*)\}\}/giu, (_, name: string) => valueMap[name] ?? `{{${name}}}`);
    }
  } catch {
    // plain value
  }
  return template.replace(/\{\{itemValue\}\}/gu, itemValue);
}

export const httpRequestAction: ActionDefinition<HttpRequestRunConfig> = {
  name: "http-request",
  configSchema: httpRequestConfigSchema,
  async execute({ itemValue, config, env }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.apiTimeoutMs);
    const apiBaseUrl = env.resolveApiBaseUrl(config.targetEnvironment);
    const apiBearerToken = await env.getApiBearerToken(config.targetEnvironment);
    const method = config.method;
    const endpoint = buildRequestUrl(apiBaseUrl, config.pathTemplate, itemValue, config.queryParams);

    const wantsBody = ["POST", "PUT", "PATCH"].includes(method);
    const bodyType = config.bodyType ?? "json";

    let fetchBody: BodyInit | undefined;
    let bodyContentType: string | undefined;
    let loggedBody: unknown;

    if (wantsBody && bodyType !== "none") {
      if (bodyType === "form") {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(config.formBody ?? {})) {
          params.append(key, interpolateTemplate(value, itemValue));
        }
        fetchBody = params.toString();
        bodyContentType = "application/x-www-form-urlencoded";
        loggedBody = Object.fromEntries(params.entries());
      } else if (bodyType === "multipart") {
        const fd = new FormData();
        for (const [key, value] of Object.entries(config.formBody ?? {})) {
          fd.append(key, interpolateTemplate(value, itemValue));
        }
        fetchBody = fd;
        // Let fetch set content-type with boundary automatically
        loggedBody = Object.fromEntries(
          [...fd.entries()].map(([k, v]) => [k, String(v)])
        );
      } else if (bodyType === "text") {
        fetchBody = interpolateTemplate(config.requestBodyText ?? "", itemValue);
        bodyContentType = "text/plain";
        loggedBody = fetchBody;
      } else {
        // json (default)
        const rawBody = config.requestBody ?? dryRunBodySchema.parse({ dry_run: config.dryRun });
        const interpolated = interpolateTemplate(JSON.stringify(rawBody), itemValue);
        fetchBody = interpolated;
        bodyContentType = "application/json";
        loggedBody = JSON.parse(interpolated) as Record<string, unknown>;
      }
    }

    // Merge custom headers, interpolating {{itemValue}} in values
    const customHeaders: Record<string, string> = {};
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        customHeaders[key] = interpolateTemplate(value, itemValue);
      }
    }

    try {
      const response = await fetch(endpoint, {
        method,
        headers: {
          authorization: `Bearer ${apiBearerToken}`,
          ...(bodyContentType ? { "content-type": bodyContentType } : {}),
          ...customHeaders
        },
        body: fetchBody,
        signal: controller.signal
      });

      // Capture response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // Read body as text first to get accurate byte size
      const responseText = await response.text();
      const responseSizeBytes = Buffer.byteLength(responseText, "utf8");

      const contentType = response.headers.get("content-type") ?? "";
      let parsedBody: unknown;
      try {
        parsedBody = contentType.includes("application/json")
          ? (JSON.parse(responseText) as unknown)
          : responseText;
      } catch {
        parsedBody = responseText;
      }

      return {
        ok: response.ok,
        httpStatus: response.status,
        request: {
          method,
          url: endpoint.toString(),
          bodyType,
          body: loggedBody,
          headers: config.headers,
          targetEnvironment: config.targetEnvironment,
          pathTemplate: config.pathTemplate,
          queryParams: config.queryParams,
          authMode: env.authMode
        },
        response: {
          body: parsedBody,
          headers: responseHeaders,
          size: responseSizeBytes
        },
        error: response.ok ? undefined : `HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown request error";

      return {
        ok: false,
        request: {
          method,
          url: endpoint.toString(),
          bodyType,
          body: loggedBody,
          headers: config.headers,
          targetEnvironment: config.targetEnvironment,
          pathTemplate: config.pathTemplate,
          queryParams: config.queryParams,
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
