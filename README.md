# Repo API Wrapper

Local-first harness for running batch API operations against your services.

It gives you a small operator surface for creating runs, pacing requests, storing responses, inspecting failures, and resuming or stopping batches from persisted local state.

## What It Does

- Creates a run with one item per input ID
- Executes each item against a configured endpoint
- Stores responses, attempts, and event logs in SQLite
- Supports pacing, retries, and stop conditions
- Includes a dashboard for run creation and monitoring
- Includes a CLI for direct runs and scripting

## Stack

- Fastify API
- React + Vite dashboard
- TypeScript services and CLI
- Prisma + SQLite
- Bottleneck for request pacing

## First Run

### 1. Install dependencies

```bash
yarn install
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

You do not need to configure a database URL. The app always uses the repo-local SQLite file at `prisma/dev.db`.

In most cases, the only thing you need to add to `.env` is the JWT secret for the module you want to use.

### 3. Add a module config

Any `.ts` file you drop in `src/config/modules/` is auto-discovered at startup. No index or registration step is required.

```bash
cp src/config/modules/_example-module.ts src/config/modules/my-service.ts
```

Edit `my-service.ts` with your service's slug, base URLs, auth config, and endpoints. Then add the required JWT secret(s) to `.env`.

Files in `src/config/modules/` without a leading `_` are gitignored, so local module configs stay on your machine.

You can also skip the manual copy step: after the app starts, use the import button in the top-left of the dashboard with a Postman collection export, and the app will generate the module config file for you on the fly.

### 4. Create the database and start the app

```bash
yarn db:push
yarn dev
```

This starts:

- API server at `http://127.0.0.1:3002`
- Dashboard at `http://127.0.0.1:5174`

If you want to run them separately:

```bash
yarn dev:api
yarn dev:web
```

## Common Commands

```bash
yarn dev           # API + dashboard
yarn dev:api       # API only
yarn dev:web       # dashboard only
yarn db:push       # create/update the local SQLite schema
yarn build         # production build
yarn serve         # serve the built app
```

## CLI Examples

```bash
# Run a batch
yarn sync:onboarding \
  --master-ids 101,102,103 \
  --target-environment staging \
  --label "March check" \
  --dry-run \
  --concurrency 2 \
  --min-delay-ms 500

# Load IDs from a file
yarn sync:onboarding --master-ids-file ./ids.txt

# Manage runs
yarn run:list
yarn run:report <run-id>
yarn run:resume <run-id>
yarn run:stop <run-id> --reason "manual stop"

# Print the current JWT
yarn auth:token
```

## Module Config Structure

Each module file in `src/config/modules/` exports a `ModuleDefinition` with:

| Field | Purpose |
|-------|---------|
| `slug` | Unique identifier for the module |
| `environments` | Base URLs for staging and prod |
| `auth` | JWT config including secret env var name, email, and expiration |
| `endpoints[]` | Route templates, HTTP methods, descriptions, and default run settings |

See `src/config/module-types.ts` for the full type definitions.

## Key Files

| File | What lives there |
|------|-----------------|
| `.env` | Secrets for local modules |
| `src/config/app.ts` | Host, port, and request timeout |
| `src/config/module-types.ts` | TypeScript interfaces for module definitions |
| `src/config/modules/` | Your local service modules |
| `src/config/modules/_example-module.ts` | Example module to copy |
| `prisma/schema.prisma` | Database schema |
| `prisma/dev.db` | Local SQLite database file |

Non-secret config is checked in so it stays versioned with the project. Secrets stay in `.env`.

## Notes

- Local-first and intentionally light on infrastructure
- SQLite keeps state transparent and easy to inspect
- The action layer is structured so new actions can be added without changing the run engine
- Stop conditions are best-effort when concurrency is greater than 1 because in-flight requests finish first
