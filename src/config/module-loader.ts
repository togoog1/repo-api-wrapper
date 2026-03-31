import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ModuleDefinition, ModuleEndpointDefinition } from "./module-types.js";

let loaded: readonly ModuleDefinition[] | undefined;

const REQUIRED_FIELDS: (keyof ModuleDefinition)[] = [
  "slug",
  "serviceName",
  "label",
  "environments",
  "auth",
  "endpoints",
];

/** Directory containing all module files. */
export function getModulesDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "modules");
}

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
      modules.push(applyOverrides(found));
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

// ── Override system ────────────────────────────────────────────────────
//
// Each module can have a sidecar `<slug>.overrides.json` file that is
// deep-merged on top of the .ts definition at load time. The UI writes
// only to the JSON file — the .ts source is never touched by edits.
//
// The "bake" (rewrite) action merges overrides into a fresh .ts file,
// backs up the original, and deletes the .overrides.json file.

function overridesPath(slug: string): string {
  return path.join(getModulesDir(), `${slug}.overrides.json`);
}

/** Deep-merge `src` into `target`. Arrays are replaced wholesale. */
function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [key, srcVal] of Object.entries(src)) {
    const tgtVal = out[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      out[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      out[key] = srcVal;
    }
  }
  return out;
}

/** Read and merge the sidecar override file if it exists. */
function applyOverrides(mod: ModuleDefinition): ModuleDefinition {
  const p = overridesPath(mod.slug);
  if (!existsSync(p)) return mod;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    console.log(`[modules] 🔧 ${mod.slug}: applied overrides from ${path.basename(p)}`);

    // Handle addedEndpoints: append to existing array instead of replacing
    const addedEndpoints = Array.isArray(raw.addedEndpoints) ? raw.addedEndpoints as ModuleEndpointDefinition[] : [];
    delete raw.addedEndpoints;

    // Handle customFolders: preserve as-is
    const customFolders = Array.isArray(raw.customFolders) ? raw.customFolders as string[][] : [];
    delete raw.customFolders;

    const merged = deepMerge(mod as unknown as Record<string, unknown>, raw) as unknown as ModuleDefinition;

    if (addedEndpoints.length > 0) {
      merged.endpoints = [...merged.endpoints, ...addedEndpoints];
    }
    if (customFolders.length > 0) {
      merged.customFolders = [...(merged.customFolders ?? []), ...customFolders];
    }

    return merged;
  } catch (err) {
    console.warn(`[modules] ⚠ ${mod.slug}: failed reading overrides — ${err instanceof Error ? err.message : err}`);
    return mod;
  }
}

/** Read the current override file for a module (empty object if none). */
export function getModuleOverrides(slug: string): Record<string, unknown> {
  const p = overridesPath(slug);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Write (or create) the override file for a module and reload modules. */
export async function saveModuleOverrides(slug: string, data: Record<string, unknown>): Promise<void> {
  // Never allow slug to be changed via overrides
  delete data.slug;
  writeFileSync(overridesPath(slug), JSON.stringify(data, null, 2) + "\n", "utf-8");
  // Reload so the in-memory modules reflect the change
  await loadModules();
}

/** Add an endpoint to a module via the override system. */
export async function addEndpointToModule(slug: string, endpoint: ModuleEndpointDefinition): Promise<void> {
  const overrides = getModuleOverrides(slug);
  const added = Array.isArray(overrides.addedEndpoints) ? (overrides.addedEndpoints as ModuleEndpointDefinition[]) : [];
  added.push(endpoint);
  overrides.addedEndpoints = added;
  await saveModuleOverrides(slug, overrides);
}

/** Add a custom folder to a module via the override system. */
export async function addFolderToModule(slug: string, folderPath: string[]): Promise<void> {
  const overrides = getModuleOverrides(slug);
  const folders = Array.isArray(overrides.customFolders) ? (overrides.customFolders as string[][]) : [];
  // Don't add duplicates
  if (!folders.some((f) => f.join("/") === folderPath.join("/"))) {
    folders.push(folderPath);
    overrides.customFolders = folders;
    await saveModuleOverrides(slug, overrides);
  }
}

/** Delete the override file for a module (usually after baking). */
export function deleteModuleOverrides(slug: string): void {
  const p = overridesPath(slug);
  if (existsSync(p)) {
    unlinkSync(p);
  }
}

// ── TS Rewrite ("bake") ───────────────────────────────────────────────

function findTsFileForSlug(slug: string): string | null {
  const dir = getModulesDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"));
  for (const file of files) {
    // Quick check: does the file export a module with this slug?
    const content = readFileSync(path.join(dir, file), "utf-8");
    if (content.includes(`slug: "${slug}"`) || content.includes(`slug: '${slug}'`)) {
      return path.join(dir, file);
    }
  }
  return null;
}

function serializeValue(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent + 1);

  if (value === null || value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => serializeValue(v, indent + 1));
    // Short arrays of primitives on one line
    if (value.every((v) => typeof v !== "object" || v === null) && items.join(", ").length < 60) {
      return `[${items.join(", ")}]`;
    }
    return `[\n${items.map((i) => `${innerPad}${i}`).join(",\n")}\n${pad}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines = entries.map(([k, v]) => {
      const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/u.test(k) ? k : JSON.stringify(k);
      return `${innerPad}${key}: ${serializeValue(v, indent + 1)},`;
    });
    return `{\n${lines.join("\n")}\n${pad}}`;
  }
  return String(value);
}

function serializeEndpoint(ep: ModuleEndpointDefinition, indent: number): string {
  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent + 1);
  const lines: string[] = [`${pad}{`];

  lines.push(`${innerPad}slug: ${JSON.stringify(ep.slug)},`);
  lines.push(`${innerPad}action: ${JSON.stringify(ep.action)},`);
  lines.push(`${innerPad}label: ${JSON.stringify(ep.label)},`);
  lines.push(`${innerPad}description: ${JSON.stringify(ep.description)},`);
  lines.push(`${innerPad}method: ${JSON.stringify(ep.method)},`);
  lines.push(`${innerPad}pathTemplate: ${JSON.stringify(ep.pathTemplate)},`);

  if (ep.folder && ep.folder.length > 0) {
    lines.push(`${innerPad}folder: [${ep.folder.map((f) => JSON.stringify(f)).join(", ")}],`);
  }
  if (ep.defaultHeaders && Object.keys(ep.defaultHeaders).length > 0) {
    lines.push(`${innerPad}defaultHeaders: ${serializeValue(ep.defaultHeaders, indent + 1)},`);
  }
  if (ep.requestBodyDescription) {
    lines.push(`${innerPad}requestBodyDescription: ${JSON.stringify(ep.requestBodyDescription)},`);
  }
  if (ep.notes) {
    lines.push(`${innerPad}notes: ${JSON.stringify(ep.notes)},`);
  }
  if (ep.defaultRunLabel) {
    lines.push(`${innerPad}defaultRunLabel: ${JSON.stringify(ep.defaultRunLabel)},`);
  }
  if (ep.defaultRunConfig && Object.keys(ep.defaultRunConfig).length > 0) {
    lines.push(`${innerPad}defaultRunConfig: ${serializeValue(ep.defaultRunConfig, indent + 1)},`);
  }

  lines.push(`${pad}}`);
  return lines.join("\n");
}

function generateModuleTs(mod: ModuleDefinition): string {
  const varName = mod.slug.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase()) + "Module";
  const lines: string[] = [];

  lines.push(`import type { ModuleDefinition } from "../module-types.js";`);
  lines.push(``);
  lines.push(`export const ${varName}: ModuleDefinition = {`);
  lines.push(`  slug: ${JSON.stringify(mod.slug)},`);
  lines.push(`  serviceName: ${JSON.stringify(mod.serviceName)},`);
  lines.push(`  label: ${JSON.stringify(mod.label)},`);
  lines.push(`  description: ${JSON.stringify(mod.description)},`);
  lines.push(`  defaultTargetEnvironment: ${JSON.stringify(mod.defaultTargetEnvironment)},`);
  lines.push(``);
  lines.push(`  environments: ${serializeValue(mod.environments, 1)},`);
  lines.push(``);
  lines.push(`  auth: ${serializeValue(mod.auth, 1)},`);

  if (mod.defaultHeaders && Object.keys(mod.defaultHeaders).length > 0) {
    lines.push(``);
    lines.push(`  defaultHeaders: ${serializeValue(mod.defaultHeaders, 1)},`);
  }

  lines.push(``);
  lines.push(`  endpoints: [`);
  for (const ep of mod.endpoints) {
    lines.push(serializeEndpoint(ep, 2) + ",");
  }
  lines.push(`  ],`);
  lines.push(`};`);
  lines.push(``);

  return lines.join("\n");
}

/**
 * "Bake" overrides into the .ts file: merge the override data into the
 * base module, regenerate the .ts file, back up the original, and delete
 * the .overrides.json. Returns the path to the backup file.
 */
export async function bakeModuleOverrides(slug: string): Promise<{ backupPath: string }> {
  const mod = getSupportedModules().find((m) => m.slug === slug);
  if (!mod) throw new Error(`Module not found: ${slug}`);

  const tsFile = findTsFileForSlug(slug);
  if (!tsFile) throw new Error(`Cannot locate .ts file for module: ${slug}`);

  // Create backup
  const backupPath = tsFile + ".bak";
  copyFileSync(tsFile, backupPath);

  // Generate new .ts content from the fully-merged module
  const content = generateModuleTs(mod);
  writeFileSync(tsFile, content, "utf-8");

  // Remove overrides file
  deleteModuleOverrides(slug);

  // Reload modules with the baked config
  await loadModules();

  return { backupPath };
}
