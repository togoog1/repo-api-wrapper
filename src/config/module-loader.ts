import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ModuleDefinition } from "./module-types.js";

let loaded: readonly ModuleDefinition[] | undefined;

const REQUIRED_FIELDS: (keyof ModuleDefinition)[] = [
  "slug",
  "serviceName",
  "label",
  "environments",
  "auth",
  "endpoints",
];

/**
 * Scan src/config/modules/ and dynamically import every .ts file.
 * Call once at app startup before accessing modules.
 *
 * Every .ts file in the modules/ folder is treated as a service module.
 * Files starting with _ are skipped (e.g. _example-module.ts).
 * Each file should export a ModuleDefinition (any named export).
 *
 * Partial or broken modules are still included with warnings logged
 * so they show up in the dashboard.
 */
export async function loadModules(): Promise<readonly ModuleDefinition[]> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "modules");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .sort();

  const modules: ModuleDefinition[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);

    let exports: Record<string, unknown>;
    try {
      exports = await import(filePath);
    } catch (err) {
      const stub = makeStubModule(file);
      stub.description = `Failed to import: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[modules] ⚠ ${file}: failed to import — ${stub.description}`);
      modules.push(stub);
      continue;
    }

    // Find the first export that looks like a module definition.
    let found: ModuleDefinition | null = null;
    for (const value of Object.values(exports)) {
      if (typeof value === "object" && value !== null && "slug" in value) {
        const partial = value as Partial<ModuleDefinition>;
        const missing = REQUIRED_FIELDS.filter((f) => !(f in partial));

        if (missing.length > 0) {
          const mod = { ...makeStubModule(file), ...partial } as ModuleDefinition;
          mod.description = `Missing fields: ${missing.join(", ")}`;
          console.warn(`[modules] ⚠ ${file}: loaded with missing fields — ${missing.join(", ")}`);
          found = mod;
        } else {
          found = value as ModuleDefinition;
        }
        break;
      }
    }

    if (found) {
      modules.push(found);
    } else {
      const stub = makeStubModule(file);
      stub.description = "No ModuleDefinition export found. Export an object with at least a slug field.";
      console.warn(`[modules] ⚠ ${file}: no ModuleDefinition export found`);
      modules.push(stub);
    }
  }

  loaded = modules;
  return modules;
}

/**
 * Return the modules that were loaded by loadModules().
 * Throws if called before loadModules() has completed.
 */
export function getSupportedModules(): readonly ModuleDefinition[] {
  if (!loaded) {
    throw new Error(
      "Modules have not been loaded yet. Call loadModules() at startup."
    );
  }

  return loaded;
}

function makeStubModule(filename: string): ModuleDefinition {
  const slug = filename.replace(/\.ts$/u, "");
  return {
    slug,
    serviceName: slug,
    label: slug,
    description: "",
    defaultTargetEnvironment: "staging",
    environments: {
      staging: { baseUrl: "" },
      prod: { baseUrl: "" },
    },
    auth: {
      mode: "jwt",
      secretEnvVar: "",
      jwt: { email: "", expiresInSeconds: 300 },
    },
    endpoints: [],
  };
}
