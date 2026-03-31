import type { ModuleDefinition } from "../module-types.js";

// ─── Example module ────────────────────────────────────────────────
//
// Copy this file and drop the _ prefix to create a module for your
// service. Any .ts file in this folder is auto-discovered at startup.
// Files starting with _ are ignored by the loader.
//
//   cp _example-module.ts my-service.ts
//
// Then fill in slug, URLs, auth, and endpoints below.

export const exampleModule: ModuleDefinition = {
  slug: "my-service",
  serviceName: "my-service",
  label: "My Service",
  description: "Short summary of what this service does.",
  defaultTargetEnvironment: "staging",

  environments: {
    staging: {
      baseUrl: "https://my-service.staging.example.com",
    },
    prod: {
      baseUrl: "https://my-service.example.com",
    },
  },

  // Auth — choose a mode: "jwt", "apikey", "bearer", or "none"
  //
  // JWT:
  //   auth: { mode: "jwt", secretEnvVar: "MY_SERVICE_JWT_SECRET",
  //           jwt: { email: "svc@example.com", expiresInSeconds: 300 } }
  //
  // API Key (header):
  //   auth: { mode: "apikey", apikey: { headerName: "x-api-key", valueEnvVar: "MY_SERVICE_API_KEY" } }
  //
  // Static Bearer token:
  //   auth: { mode: "bearer", bearer: { tokenEnvVar: "MY_SERVICE_BEARER_TOKEN" } }
  //
  // No auth:
  //   auth: { mode: "none" }
  //
  auth: {
    mode: "jwt",
    secretEnvVar: "MY_SERVICE_JWT_SECRET",
    // Optional: fall back to an older env var name during migration
    jwt: {
      email: "service-account@example.com",
      subject: undefined,
      issuer: undefined,
      audience: undefined,
      expiresInSeconds: 300,
    },
  },

  endpoints: [
    {
      slug: "sync-example",
      action: "http-request",
      label: "Sync example",
      description: "What this endpoint does and when you would run it.",
      method: "POST",
      pathTemplate: "/resource/:id",
      requestBodyDescription: "{ dry_run: boolean }",
      notes: "Any auth notes, rate-limit caveats, or preconditions.",
      defaultRunLabel: "sync-example",
      defaultRunConfig: {
        dryRun: true,
        concurrency: 1,
        minDelayMs: 250,
        maxRetries: 1,
        retryDelayMs: 1500,
        stopOnHttpStatuses: [401, 403],
      },
    },
  ],
};
