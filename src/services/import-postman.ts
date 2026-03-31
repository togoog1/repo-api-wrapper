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
  formdata?: Array<{ key: string; value?: string; type?: string }>;
  urlencoded?: Array<{ key: string; value?: string }>;
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
  folder: string[];
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  bodyType?: string;
  requestBody?: Record<string, unknown>;
  formBody?: Record<string, string>;
  requestBodyText?: string;
  requestBodyDescription?: string;
  notes?: string;
}

interface ConvertedAuth {
  mode: "jwt" | "apikey" | "bearer" | "none";
  secretEnvVar?: string;
  jwt?: { email: string; expiresInSeconds: number };
  apikey?: { headerName: string; valueEnvVar: string };
  bearer?: { tokenEnvVar: string };
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

function extractQueryParams(url: PostmanUrl | string | undefined): Record<string, string> | undefined {
  if (!url || typeof url === "string") return undefined;
  if (!url.query || url.query.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const { key, value } of url.query) {
    if (key) result[key] = value ?? "";
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
  if (body.mode === "urlencoded" && body.urlencoded) {
    const keys = body.urlencoded.map((f) => f.key);
    return `Form: { ${keys.join(", ")} }`;
  }
  return undefined;
}

const AUTO_GENERATED_HEADERS = new Set([
  "host", "user-agent", "accept", "accept-encoding",
  "connection", "postman-token", "cache-control",
  "content-type", "content-length"
]);

function extractHeaders(headers: PostmanRequest["header"]): Record<string, string> | undefined {
  if (!headers || headers.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const { key, value } of headers) {
    if (key && !AUTO_GENERATED_HEADERS.has(key.toLowerCase())) {
      result[key] = value ?? "";
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractBody(body: PostmanBody | undefined): {
  bodyType: string;
  requestBody?: Record<string, unknown>;
  formBody?: Record<string, string>;
  requestBodyText?: string;
} | undefined {
  if (!body || !body.mode) return undefined;

  if (body.mode === "raw" && body.raw) {
    const trimmed = body.raw.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return { bodyType: "json", requestBody: parsed };
    } catch {
      return { bodyType: "text", requestBodyText: trimmed };
    }
  }

  if (body.mode === "formdata" && body.formdata) {
    const formBody: Record<string, string> = {};
    for (const { key, value } of body.formdata) {
      if (key) formBody[key] = value ?? "";
    }
    if (Object.keys(formBody).length === 0) return undefined;
    return { bodyType: "multipart", formBody };
  }

  if (body.mode === "urlencoded" && body.urlencoded) {
    const formBody: Record<string, string> = {};
    for (const { key, value } of body.urlencoded) {
      if (key) formBody[key] = value ?? "";
    }
    if (Object.keys(formBody).length === 0) return undefined;
    return { bodyType: "form", formBody };
  }

  return undefined;
}

function convertAuth(auth: PostmanAuth | undefined, slug: string): ConvertedAuth {
  const envPrefix = slug.toUpperCase().replace(/-/gu, "_");

  if (!auth || !auth.type || auth.type === "noauth") {
    return { mode: "none" };
  }

  if (auth.type === "apikey" && auth.apikey) {
    const keyEntry = auth.apikey.find((a) => a.key === "key");
    const headerName = keyEntry?.value ?? "x-api-key";
    return {
      mode: "apikey",
      apikey: {
        headerName,
        valueEnvVar: `${envPrefix}_API_KEY`,
      },
    };
  }

  if (auth.type === "bearer") {
    return {
      mode: "bearer",
      bearer: {
        tokenEnvVar: `${envPrefix}_BEARER_TOKEN`,
      },
    };
  }

  // Default to JWT for recognized auth types
  return {
    mode: "jwt",
    secretEnvVar: `${envPrefix}_JWT_SECRET`,
    jwt: {
      email: "service-account@example.com",
      expiresInSeconds: 300,
    },
  };
}

function flattenItems(items: PostmanItem[], path: string[] = []): Array<{ item: PostmanItem; folderPath: string[] }> {
  const results: Array<{ item: PostmanItem; folderPath: string[] }> = [];
  for (const item of items) {
    if (item.request) {
      results.push({ item, folderPath: path });
    }
    if (item.item) {
      results.push(...flattenItems(item.item, [...path, item.name ?? ""]));
    }
  }
  return results;
}

function convertCollection(collection: PostmanCollection): {
  name: string;
  description: string;
  endpoints: ConvertedEndpoint[];
  auth: ConvertedAuth;
} {
  const name = collection.info?.name ?? "imported-service";
  const description = collection.info?.description ?? `Imported from Postman collection: ${name}`;

  const auth = convertAuth(collection.auth, slugify(name));

  const flat = flattenItems(collection.item ?? []);
  const seenSlugs = new Set<string>();
  const endpoints: ConvertedEndpoint[] = [];

  for (const { item, folderPath } of flat) {
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

    const queryParams = extractQueryParams(req.url);
    const headers = extractHeaders(req.header);
    const bodyInfo = extractBody(req.body);
    const bodyDesc = extractBodyDescription(req.body);
    const endpointDescription =
      (typeof req.description === "string" && req.description)
        ? req.description
        : `${method} ${pathTemplate}`;

    endpoints.push({
      slug,
      label: item.name ?? slug,
      description: endpointDescription,
      method,
      pathTemplate,
      folder: folderPath,
      queryParams,
      headers,
      bodyType: bodyInfo?.bodyType,
      requestBody: bodyInfo?.requestBody,
      formBody: bodyInfo?.formBody,
      requestBodyText: bodyInfo?.requestBodyText,
      requestBodyDescription: bodyDesc,
    });
  }

  return { name, description, endpoints, auth };
}

// ── File generation ────────────────────────────────────────────────

function generateModuleFile(opts: {
  exportName: string;
  slug: string;
  label: string;
  description: string;
  endpoints: ConvertedEndpoint[];
  auth: ConvertedAuth;
}): string {
  const lines: string[] = [];
  lines.push(`import type { ModuleDefinition } from "../module-types.js";`);
  lines.push(``);
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

  // Auth
  const a = opts.auth;
  lines.push(`  auth: {`);
  lines.push(`    mode: ${JSON.stringify(a.mode)},`);
  if (a.mode === "jwt") {
    lines.push(`    secretEnvVar: ${JSON.stringify(a.secretEnvVar)},`);
    lines.push(`    jwt: {`);
    lines.push(`      email: ${JSON.stringify(a.jwt?.email ?? "service-account@example.com")},`);
    lines.push(`      expiresInSeconds: ${a.jwt?.expiresInSeconds ?? 300},`);
    lines.push(`    },`);
  } else if (a.mode === "apikey" && a.apikey) {
    lines.push(`    apikey: {`);
    lines.push(`      headerName: ${JSON.stringify(a.apikey.headerName)},`);
    lines.push(`      valueEnvVar: ${JSON.stringify(a.apikey.valueEnvVar)},`);
    lines.push(`    },`);
  } else if (a.mode === "bearer" && a.bearer) {
    lines.push(`    bearer: {`);
    lines.push(`      tokenEnvVar: ${JSON.stringify(a.bearer.tokenEnvVar)},`);
    lines.push(`    },`);
  }
  lines.push(`  },`);
  lines.push(``);
  lines.push(`  endpoints: [`);

  for (const ep of opts.endpoints) {
    lines.push(`    {`);
    lines.push(`      slug: ${JSON.stringify(ep.slug)},`);
    lines.push(`      action: "http-request",`);
    lines.push(`      label: ${JSON.stringify(ep.label)},`);
    lines.push(`      description: ${JSON.stringify(ep.description)},`);
    lines.push(`      method: ${JSON.stringify(ep.method)},`);
    lines.push(`      pathTemplate: ${JSON.stringify(ep.pathTemplate)},`);
    if (ep.folder.length > 0) {
      lines.push(`      folder: ${JSON.stringify(ep.folder)},`);
    }
    if (ep.headers) {
      lines.push(`      defaultHeaders: ${JSON.stringify(ep.headers)},`);
    }
    if (ep.requestBodyDescription) {
      lines.push(`      requestBodyDescription: ${JSON.stringify(ep.requestBodyDescription)},`);
    }
    const hasDefaults = ep.queryParams || ep.headers || ep.bodyType || ep.method !== "POST";
    if (hasDefaults) {
      lines.push(`      defaultRunConfig: {`);
      lines.push(`        method: ${JSON.stringify(ep.method)},`);
      if (ep.queryParams) {
        lines.push(`        queryParams: ${JSON.stringify(ep.queryParams)},`);
      }
      if (ep.headers) {
        lines.push(`        headers: ${JSON.stringify(ep.headers)},`);
      }
      if (ep.bodyType) {
        lines.push(`        bodyType: ${JSON.stringify(ep.bodyType)},`);
        if (ep.requestBody) {
          lines.push(`        requestBody: ${JSON.stringify(ep.requestBody)},`);
        }
        if (ep.formBody) {
          lines.push(`        formBody: ${JSON.stringify(ep.formBody)},`);
        }
        if (ep.requestBodyText) {
          lines.push(`        requestBodyText: ${JSON.stringify(ep.requestBodyText)},`);
        }
      }
      lines.push(`      },`);
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

  const { name, description, endpoints, auth } = convertCollection(collection);

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
    auth,
  });

  await writeFile(filePath, content, "utf8");

  return {
    filename,
    slug,
    label: name,
    endpointCount: endpoints.length,
  };
}
