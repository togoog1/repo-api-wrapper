import "dotenv/config";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { RunItemStatus } from "./generated/prisma/client.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { appConfig } from "./config/app.js";
import { loadModules } from "./config/module-loader.js";
import { getPublicRuntimeConfig } from "./lib/env.js";
import { prisma } from "./lib/prisma.js";
import { targetEnvironmentSchema } from "./lib/target-environment.js";
import {
  createSavedInputList,
  createSavedInputListFromRunFailures,
  deleteSavedInputList,
  inputListDataSchema,
  listSavedInputLists
} from "./services/input-lists.js";
import {
  createAndStartHttpRequestRun,
  createRetryRunFromFailures,
  getRunOverview,
  listRunEvents,
  listRunItems,
  listRuns,
  resumeRun,
  stopRun
} from "./services/runs.js";
import { importPostmanCollection } from "./services/import-postman.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const clientDistPath = path.join(projectRoot, "web", "dist");

const createRunRequestSchema = z
  .object({
    moduleSlug: z.string().trim().min(1).optional(),
    endpointSlug: z.string().trim().min(1).optional(),
    inputListId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).max(120).optional(),
    itemValues: z.array(z.string().min(1)).default([]),
    targetEnvironment: targetEnvironmentSchema.optional(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
    pathTemplate: z.string().trim().min(1).optional(),
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
    stopOnHttpStatuses: z.array(z.number().int().min(100).max(599)).default([]),
    skipAuth: z.boolean().default(false),
    disabledDefaultHeaders: z.array(z.string()).default([])
  })
  ;

const createInputListRequestSchema = z.object({
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(240).optional(),
  moduleSlug: z.string().trim().min(1).optional(),
  itemType: z.string().trim().min(1).max(40).default("item_value"),
  data: inputListDataSchema
});

const statusSchema = z.enum([
  RunItemStatus.PENDING,
  RunItemStatus.RUNNING,
  RunItemStatus.SUCCEEDED,
  RunItemStatus.FAILED,
  RunItemStatus.STOPPED
]);


function normalizeError(error: unknown): { statusCode: number; message: string } {
  if (error instanceof z.ZodError) {
    return {
      statusCode: 400,
      message: error.issues.map((issue) => issue.message).join("; ")
    };
  }
  if (error instanceof Error) {
    const statusCode = error.message.includes("not found") ? 404 : 500;
    return {
      statusCode,
      message: error.message
    };
  }

  return {
    statusCode: 500,
    message: "Unknown server error"
  };
}

async function buildServer() {
  const app = Fastify({
    logger: true,
    disableRequestLogging: true
  });

  await app.register(cors, {
    origin: true
  });

  app.get("/api/health", async () => ({
    ok: true
  }));

  app.get("/api/config", async () => getPublicRuntimeConfig());

  app.get("/api/input-lists", async (request, reply) => {
    try {
      const query = request.query as { moduleSlug?: string };
      return await listSavedInputLists(query.moduleSlug);
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.post("/api/input-lists", async (request, reply) => {
    try {
      const body = createInputListRequestSchema.parse(request.body);
      const inputList = await createSavedInputList(body);

      return reply.status(201).send(inputList);
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.delete("/api/input-lists/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await deleteSavedInputList(id);
      return { ok: true };
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.get("/api/runs", async (request, reply) => {
    try {
      const limit = Number.parseInt(String((request.query as { limit?: string }).limit ?? "24"), 10);
      return await listRuns(Number.isNaN(limit) ? 24 : limit);
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.get("/api/runs/:runId", async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      return await getRunOverview(runId);
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.get("/api/runs/:runId/items", async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      const query = request.query as { status?: string };
      const status = query.status ? statusSchema.parse(query.status) : undefined;

      return await listRunItems({
        runId,
        status
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.get("/api/runs/:runId/events", async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      const limit = Number.parseInt(String((request.query as { limit?: string }).limit ?? "80"), 10);

      return await listRunEvents(runId, Number.isNaN(limit) ? 80 : limit);
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.post("/api/runs/http-request", async (request, reply) => {
    try {
      const body = createRunRequestSchema.parse(request.body);
      const runId = await createAndStartHttpRequestRun(body);

      return reply.status(201).send({
        runId
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.post("/api/runs/:runId/retry-failures", async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      const nextRunId = await createRetryRunFromFailures(runId);

      return reply.status(201).send({
        runId: nextRunId
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.post("/api/runs/:runId/failure-list", async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      const inputList = await createSavedInputListFromRunFailures(runId);
      return reply.status(201).send(inputList);
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.post("/api/runs/:runId/resume", async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      await resumeRun(runId);
      return {
        ok: true
      };
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.post("/api/runs/:runId/stop", async (request, reply) => {
    try {
      const { runId } = request.params as { runId: string };
      const body = z
        .object({
          reason: z.string().trim().min(1).default("Stop requested from dashboard")
        })
        .parse(request.body ?? {});

      await stopRun(runId, body.reason);
      return {
        ok: true
      };
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.post("/api/parse/ids", async (request, reply) => {
    try {
      const body = z.object({ raw: z.string() }).parse(request.body);
      const ids = body.raw.split(/[\s,]+/u).map((s) => s.trim()).filter(Boolean);
      return { itemValues: ids };
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });

  app.post("/api/modules/import-postman", async (request, reply) => {
    try {
      const result = await importPostmanCollection(request.body);
      // Reload modules so the new one is immediately available
      await loadModules();
      return reply.status(201).send(result);
    } catch (error) {
      const normalized = normalizeError(error);
      return reply.status(normalized.statusCode).send({
        error: normalized.message
      });
    }
  });


  if (existsSync(clientDistPath)) {
    await app.register(fastifyStatic, {
      root: path.join(clientDistPath, "assets"),
      prefix: "/assets/"
    });

    app.get("/", async (_request, reply) => {
      const html = await readFile(path.join(clientDistPath, "index.html"), "utf8");
      return reply.type("text/html").send(html);
    });

    app.get("/*", async (_request, reply) => {
      const html = await readFile(path.join(clientDistPath, "index.html"), "utf8");
      return reply.type("text/html").send(html);
    });
  }

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return app;
}

await loadModules();
const app = await buildServer();
const port = appConfig.server.port;
const host = appConfig.server.host;

await app.listen({
  port,
  host
});
