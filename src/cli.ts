import "dotenv/config";

import { RunStatus } from "./generated/prisma/client.js";
import { Command } from "commander";
import { readFile } from "node:fs/promises";

import { loadModules } from "./config/module-loader.js";
import { httpRequestInputSchema } from "./actions/parse-http-request-input.js";
import { getEnv, getPublicRuntimeConfig } from "./lib/env.js";
import { parseInteger } from "./lib/parse.js";
import { prisma } from "./lib/prisma.js";
import { targetEnvironmentSchema } from "./lib/target-environment.js";
import { executeRun } from "./runner/execute-run.js";
import { printRunReport } from "./runner/report-run.js";
import { createHttpRequestRun } from "./services/runs.js";

async function readIdsFromFile(filePath: string): Promise<string[]> {
  const contents = await readFile(filePath, "utf8");
  return contents.split(/[\s,]+/u).map((v) => v.trim()).filter(Boolean);
}

function parseIds(rawValue?: string): string[] {
  if (!rawValue) return [];
  return rawValue.split(",").map((v) => v.trim()).filter(Boolean);
}

const program = new Command();

program.name("repo-api-wrapper").description("Local CLX action harness");

program
  .command("run")
  .description("Create and execute a batch HTTP request run")
  .option("--module-slug <slug>", "Module slug to use")
  .option("--endpoint-slug <slug>", "Endpoint slug within the selected module")
  .option("--ids <values>", "Comma-separated IDs or values")
  .option("--ids-file <path>", "File with comma or newline-separated IDs")
  .option("--dry-run", "Send dry_run=true")
  .option(
    "--target-environment <env>",
    "Target environment for API calls (staging or prod)"
  )
  .option(
    "--path-template <template>",
    "Request path template, for example /api/v1/resource/:id"
  )
  .option("--label <text>", "Optional label for the run")
  .option("--concurrency <count>", "Concurrent requests", "1")
  .option("--min-delay-ms <ms>", "Minimum delay between requests", "0")
  .option("--max-requests-per-minute <count>", "Global requests per minute")
  .option("--max-retries <count>", "Retries per item", "0")
  .option("--retry-delay-ms <ms>", "Base delay between retries", "1000")
  .option("--stop-after-failures <count>", "Stop the run after N failed items")
  .option(
    "--stop-after-consecutive-failures <count>",
    "Stop the run after N failed items in a row"
  )
  .option("--stop-on-http <codes>", "Comma-separated HTTP status codes that stop the run")
  .action(async (options) => {
    const inlineIds = parseIds(options.ids);
    const fileIds = options.idsFile
      ? await readIdsFromFile(options.idsFile)
      : [];
    const stopOnHttpStatuses = parseIds(options.stopOnHttp);
    const itemValues = [...inlineIds, ...fileIds];

    const input = httpRequestInputSchema.parse({
      itemValues,
      targetEnvironment: options.targetEnvironment
        ? targetEnvironmentSchema.parse(options.targetEnvironment)
        : undefined,
      pathTemplate: options.pathTemplate,
      label: options.label,
      dryRun: Boolean(options.dryRun),
      concurrency: parseInteger(options.concurrency, "concurrency"),
      minDelayMs: parseInteger(options.minDelayMs, "min delay"),
      maxRequestsPerMinute: options.maxRequestsPerMinute
        ? parseInteger(options.maxRequestsPerMinute, "max requests per minute")
        : undefined,
      maxRetries: parseInteger(options.maxRetries, "max retries"),
      retryDelayMs: parseInteger(options.retryDelayMs, "retry delay"),
      stopAfterFailures: options.stopAfterFailures
        ? parseInteger(options.stopAfterFailures, "stop after failures")
        : undefined,
      stopAfterConsecutiveFailures: options.stopAfterConsecutiveFailures
        ? parseInteger(
            options.stopAfterConsecutiveFailures,
            "stop after consecutive failures"
          )
        : undefined,
      stopOnHttpStatuses
    });
    const runId = await createHttpRequestRun({
      ...input,
      moduleSlug: options.moduleSlug,
      endpointSlug: options.endpointSlug
    });

    console.log(`Created run ${runId}`);
    await executeRun(runId);
    await printRunReport(runId);
  });

program
  .command("resume")
  .argument("<run-id>", "Run ID")
  .description("Resume a previously created run")
  .action(async (runId) => {
    await executeRun(runId);
    await printRunReport(runId);
  });

program
  .command("stop")
  .argument("<run-id>", "Run ID")
  .description("Request a stop for a run")
  .option("--reason <text>", "Stop reason", "Stop requested from CLI")
  .action(async (runId, options) => {
    await prisma.run.update({
      where: { id: runId },
      data: {
        stopRequestedAt: new Date(),
        stopReason: options.reason,
        status: RunStatus.STOPPED
      }
    });

    console.log(`Stop requested for ${runId}`);
  });

program
  .command("report")
  .argument("<run-id>", "Run ID")
  .description("Print a JSON report for a run")
  .action(async (runId) => {
    await printRunReport(runId);
  });

program
  .command("list-runs")
  .description("List recent runs")
  .action(async () => {
    const runs = await prisma.run.findMany({
      orderBy: {
        createdAt: "desc"
      },
      take: 20,
      select: {
        id: true,
        slug: true,
        action: true,
        moduleSlug: true,
        status: true,
        totalItems: true,
        completedItems: true,
        failedItems: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true
      }
    });

    console.log(JSON.stringify(runs, null, 2));
  });

program
  .command("print-auth-token")
  .description("Generate and print the current bearer token for GBPA auth")
  .action(async () => {
    const env = getEnv();
    const runtime = getPublicRuntimeConfig();
    const token = await env.getApiBearerToken();

    console.log(
      JSON.stringify(
        {
          authMode: runtime.authMode,
          defaultTargetEnvironment: runtime.defaultTargetEnvironment,
          jwtEmail: runtime.jwtEmail,
          token
        },
        null,
        2
      )
    );
  });

try {
  await loadModules();
  await program.parseAsync(process.argv);
} finally {
  await prisma.$disconnect();
}
