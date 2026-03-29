import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = path.resolve(__dirname, "..", "config", "modules");

// ── Postman collection types (v2.1) ────────────────────────────────

interface PostmanUrl {
  raw?: string;
  protocol?: string;
  host?: string[];
  port?: string;
  path?: string[];
  query?: Array<{ key: string; value?: string }>;
  variable?: Array<{ key: string; value?: string }>;
}

interface PostmanBody {
  mode?: string;
  raw?: string;
  formdata?: Array<{ key: string; value?: string }>;
}

interface PostmanRequest {
  method?: string;
  url?: PostmanUrl | string;
  body?: PostmanBody;
  header?: Array<{ key: string; value?: string }>;
  description?: string;
}

interface PostmanItem {
  name?: string;
  request?: PostmanRequest;
  item?: PostmanItem[];
}

interface PostmanAuth {
  type?: string;
  apikey?: Array<{ key: string; value?: string }>;
  bearer?: Array<{ key: string; value?: string }>;
}

interface PostmanCollection {
  info?: { name?: string; description?: string };
  auth?: PostmanAuth;
  item?: PostmanItem[];
}

// ── Conversion ─────────────────────────────────────────────────────

interface ConvertedEndpoint {
  slug: string;
  label: string;
  description: string;
  method: string;
  pathTemplate: string;
  requestBodyDescription?: string;
  notes?: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function extractPath(url: PostmanUrl | string | undefined): string {
  if (!url) return "/";
  if (typeof url === "string") {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }
  if (url.path) {
    return "/" + url.path.join("/");
  }
  if (url.raw) {
    try {
      return new URL(url.raw).pathname;
    } catch {
      // raw might be like "localhost:8085/foo/bar"
      const match = url.raw.match(/(?:https?:\/\/)?[^/]+(\/.*?)(?:\?|$)/u);
      return match?.[1] ?? "/";
    }
  }
  return "/";
}

function extractQueryNotes(url: PostmanUrl | string | undefined): string | undefined {
  if (!url || typeof url === "string") return undefined;
  if (!url.query || url.query.length === 0) return undefined;
  const params = url.query.map((q) => q.key).join(", ");
  return `Query params: ${params}`;
}

function extractBodyDescription(body: PostmanBody | undefined): string | undefined {
  if (!body) return undefined;
  if (body.mode === "raw" && body.raw) {
    const trimmed = body.raw.trim();
    if (trimmed.length <= 200) return trimmed;
    return trimmed.slice(0, 197) + "...";
  }
  if (body.mode === "formdata" && body.formdata) {
    const keys = body.formdata.map((f) => f.key);
    return `FormData: { ${keys.join(", ")} }`;
  }
  return undefined;
}

function flattenItems(items: PostmanItem[], prefix?: string): Array<{ item: PostmanItem; folder: string }> {
  const results: Array<{ item: PostmanItem; folder: string }> = [];
  for (const item of items) {
    const name = prefix ? `${prefix} / ${item.name ?? ""}` : (item.name ?? "");
    if (item.request) {
      results.push({ item, folder: prefix ?? "" });
    }
    if (item.item) {
      results.push(...flattenItems(item.item, item.name ?? ""));
    }
  }
  return results;
}

function convertCollection(collection: PostmanCollection): {
  name: string;
  description: string;
  endpoints: ConvertedEndpoint[];
  authNotes: string | undefined;
} {
  const name = collection.info?.name ?? "imported-service";
  const description = collection.info?.description ?? `Imported from Postman collection: ${name}`;

  // Auth notes
  let authNotes: string | undefined;
  if (collection.auth) {
    if (collection.auth.type === "apikey" && collection.auth.apikey) {
      const keyEntry = collection.auth.apikey.find((a) => a.key === "key");
      const valEntry = collection.auth.apikey.find((a) => a.key === "value");
      authNotes = `API Key auth: header "${keyEntry?.value ?? "?"}" = "${valEntry?.value ?? "?"}"`;
    } else if (collection.auth.type === "bearer") {
      authNotes = "Bearer token auth configured at collection level";
    }
  }

  const flat = flattenItems(collection.item ?? []);
  const seenSlugs = new Set<string>();
  const endpoints: ConvertedEndpoint[] = [];

  for (const { item, folder } of flat) {
    const req = item.request;
    if (!req) continue;

    const method = (typeof req.method === "string" ? req.method : "GET").toUpperCase();
    const pathTemplate = extractPath(req.url);
    let slug = slugify(item.name ?? "endpoint");

    // Deduplicate slugs
    if (seenSlugs.has(slug)) {
      let i = 2;
      while (seenSlugs.has(`${slug}-${i}`)) i++;
      slug = `${slug}-${i}`;
    }
    seenSlugs.add(slug);

    const queryNotes = extractQueryNotes(req.url);
    const bodyDesc = extractBodyDescription(req.body);
    const descParts: string[] = [];
    if (folder) descParts.push(`Folder: ${folder}`);
    if (typeof req.description === "string" && req.description) {
      descParts.push(req.description);
    }

    endpoints.push({
      slug,
      label: item.name ?? slug,
      description: descParts.join(". ") || `${method} ${pathTemplate}`,
      method,
      pathTemplate,
      requestBodyDescription: bodyDesc,
      notes: queryNotes,
    });
  }

  return { name, description, endpoints, authNotes };
}

// ── File generation ────────────────────────────────────────────────

function generateModuleFile(opts: {
  exportName: string;
  slug: string;
  label: string;
  description: string;
  endpoints: ConvertedEndpoint[];
  authNotes: string | undefined;
}): string {
  const lines: string[] = [];
  lines.push(`import type { ModuleDefinition } from "../module-types.js";`);
  lines.push(``);
  if (opts.authNotes) {
    lines.push(`// Auth from Postman collection: ${opts.authNotes}`);
  }
  lines.push(`export const ${opts.exportName}: ModuleDefinition = {`);
  lines.push(`  slug: ${JSON.stringify(opts.slug)},`);
  lines.push(`  serviceName: ${JSON.stringify(opts.slug)},`);
  lines.push(`  label: ${JSON.stringify(opts.label)},`);
  lines.push(`  description: ${JSON.stringify(opts.description)},`);
  lines.push(`  defaultTargetEnvironment: "staging",`);
  lines.push(``);
  lines.push(`  environments: {`);
  lines.push(`    staging: {`);
  lines.push(`      baseUrl: "http://localhost:8085",`);
  lines.push(`    },`);
  lines.push(`    prod: {`);
  lines.push(`      baseUrl: "https://FILL_IN_PROD_URL",`);
  lines.push(`    },`);
  lines.push(`  },`);
  lines.push(``);
  lines.push(`  auth: {`);
  lines.push(`    mode: "jwt",`);
  lines.push(`    secretEnvVar: "${opts.slug.toUpperCase().replace(/-/gu, "_")}_JWT_SECRET",`);
  lines.push(`    jwt: {`);
  lines.push(`      email: "service-account@example.com",`);
  lines.push(`      expiresInSeconds: 300,`);
  lines.push(`    },`);
  lines.push(`  },`);
  lines.push(``);
  lines.push(`  endpoints: [`);

  for (const ep of opts.endpoints) {
    lines.push(`    {`);
    lines.push(`      slug: ${JSON.stringify(ep.slug)},`);
    lines.push(`      action: "sync-onboarding",`);
    lines.push(`      label: ${JSON.stringify(ep.label)},`);
    lines.push(`      description: ${JSON.stringify(ep.description)},`);
    lines.push(`      method: ${JSON.stringify(ep.method)},`);
    lines.push(`      pathTemplate: ${JSON.stringify(ep.pathTemplate)},`);
    if (ep.requestBodyDescription) {
      lines.push(`      requestBodyDescription: ${JSON.stringify(ep.requestBodyDescription)},`);
    }
    if (ep.notes) {
      lines.push(`      notes: ${JSON.stringify(ep.notes)},`);
    }
    lines.push(`    },`);
  }

  lines.push(`  ],`);
  lines.push(`};`);
  lines.push(``);

  return lines.join("\n");
}

// ── Public API ─────────────────────────────────────────────────────

export interface ImportResult {
  filename: string;
  slug: string;
  label: string;
  endpointCount: number;
}

export async function importPostmanCollection(
  collectionJson: unknown
): Promise<ImportResult> {
  const collection = collectionJson as PostmanCollection;
  if (!collection.item || !Array.isArray(collection.item)) {
    throw new Error("Invalid Postman collection: missing item array");
  }

  const { name, description, endpoints, authNotes } = convertCollection(collection);

  const slug = slugify(name);
  const exportName = slug.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase()) + "Module";
  const filename = `${slug}.ts`;
  const filePath = path.join(MODULES_DIR, filename);

  const content = generateModuleFile({
    exportName,
    slug,
    label: name,
    description,
    endpoints,
    authNotes,
  });

  await writeFile(filePath, content, "utf8");

  return {
    filename,
    slug,
    label: name,
    endpointCount: endpoints.length,
  };
}
