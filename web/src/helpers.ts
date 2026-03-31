import { useEffect, useEffectEvent } from "react";
import type {
  CreateRunFormState,
  ModuleCatalog,
  ModuleEndpointCatalog,
  NavFolderNode,
  ParsedItemResponse,
  QueryParamRow,
  TargetEnvironment,
} from "./types";

/* ── Formatting ──────────────────────────────────────────────────── */

export function formatDate(value: string | null): string {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value)
  );
}

export function formatRuntime(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "Waiting";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatStructuredValue(value: unknown): string {
  if (value === null || value === undefined) return "No data";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatConfigValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined || value === "") return "Not set";
  return String(value);
}

export function formatInputListData(data: unknown): string {
  if (!Array.isArray(data)) return "";
  return data
    .map((v) => {
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        return String(v);
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    })
    .join("\n");
}

/* ── Parsing ─────────────────────────────────────────────────────── */

export function extractAllPathTokens(pathTemplate: string): string[] {
  const matches = pathTemplate.match(/:[a-z][a-z0-9_]*|\{[a-z][a-z0-9_]*\}/giu) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^[:{]|\}$/gu, "")))];
}

export function parseIdList(raw: string): string[] {
  return raw.split(/[\s,]+/u).map((v) => v.trim()).filter(Boolean);
}

export function applyEnvVars(template: string, vars: QueryParamRow[]): string {
  return vars
    .filter((v) => v.key.trim())
    .reduce((s, v) => s.replaceAll(`{{${v.key.trim()}}}`, v.value), template);
}

export function parseItemResponse(raw: unknown): ParsedItemResponse {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    ("body" in raw || "headers" in raw)
  ) {
    const r = raw as Record<string, unknown>;
    return {
      body: r.body,
      headers: (r.headers as Record<string, string>) ?? {},
      size: typeof r.size === "number" ? r.size : null,
      durationMs: typeof r.durationMs === "number" ? r.durationMs : null,
    };
  }
  return { body: raw, headers: {}, size: null, durationMs: null };
}

/* ── HTML / JSON ─────────────────────────────────────────────────── */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function syntaxHighlightJson(value: unknown): string {
  if (typeof value === "string" && !value.startsWith("{") && !value.startsWith("[")) {
    return `<span class="json-str">${escapeHtml(value)}</span>`;
  }
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    return escapeHtml(String(value));
  }
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "json-num";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-str";
      } else if (/true|false/.test(match)) {
        cls = "json-bool";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

export function highlightSearch(html: string, search: string): string {
  if (!search.trim()) return html;
  const escaped = escapeHtml(search);
  const regex = new RegExp(`(${escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return html.replace(/(<[^>]*>)|([^<]+)/g, (_, tag: string, text: string) => {
    if (tag) return tag;
    return text.replace(regex, '<mark class="search-hit">$1</mark>');
  });
}

/* ── URL Building ────────────────────────────────────────────────── */

export function buildPreviewUrl(input: {
  baseUrl?: string;
  pathTemplate: string;
  idsRaw: string;
  tokenValues?: Record<string, string>;
  queryParams?: QueryParamRow[];
  envVars?: QueryParamRow[];
}): string {
  const ev = input.envVars ?? [];
  const rawPath = applyEnvVars(input.pathTemplate.trim(), ev);
  const normalizedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const tokens = extractAllPathTokens(normalizedPath);
  const tv = input.tokenValues ?? {};

  let resolved: string;
  if (tokens.length > 1) {
    resolved = normalizedPath.replace(/:[a-z][a-z0-9_]*|\{[a-z][a-z0-9_]*\}/giu, (match) => {
      const name = match.replace(/^[:{]|\}$/gu, "");
      const sample = parseIdList(tv[name] ?? "")[0] ?? name;
      return sample;
    });
  } else {
    const sampleId = parseIdList(input.idsRaw)[0] ?? "12345";
    resolved = normalizedPath.replace(/:[a-z][a-z0-9_]*|\{[a-z][a-z0-9_]*\}/giu, String(sampleId));
  }

  const activeParams = (input.queryParams ?? []).filter((p) => p.key.trim());
  try {
    const url = new URL(resolved, input.baseUrl ?? "http://x");
    for (const { key, value } of activeParams) {
      url.searchParams.append(key.trim(), applyEnvVars(value, ev));
    }
    return input.baseUrl ? url.toString() : url.pathname + url.search;
  } catch {
    return resolved;
  }
}

/* ── Module / Endpoint helpers ───────────────────────────────────── */

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export function getSelectedModule(modules: ModuleCatalog[], slug: string): ModuleCatalog | null {
  return modules.find((m) => m.slug === slug) ?? null;
}

export function getSelectedEndpoint(
  mod: ModuleCatalog | null,
  slug: string
): ModuleEndpointCatalog | null {
  if (!mod) return null;
  return mod.endpoints.find((e) => e.slug === slug) ?? mod.endpoints[0] ?? null;
}

export function getEndpointPathGroup(pathTemplate: string): string {
  const normalized = pathTemplate.trim().startsWith("/")
    ? pathTemplate.trim()
    : `/${pathTemplate.trim()}`;
  const [first] = normalized.split("/").filter(Boolean);
  return first ? first : "misc";
}

/* ── Folder tree ─────────────────────────────────────────────────── */

export function buildFolderTree(moduleKey: string, endpoints: ModuleEndpointCatalog[], customFolders?: string[][]): NavFolderNode {
  const root: NavFolderNode = { name: "", key: moduleKey, children: [], endpoints: [] };

  function getOrCreateChild(parent: NavFolderNode, name: string): NavFolderNode {
    let child = parent.children.find((c) => c.name === name);
    if (!child) {
      child = { name, key: `${parent.key}/${name}`, children: [], endpoints: [] };
      parent.children.push(child);
    }
    return child;
  }

  if (customFolders) {
    for (const folderPath of customFolders) {
      let node = root;
      for (const part of folderPath) {
        node = getOrCreateChild(node, part);
      }
    }
  }

  for (const ep of endpoints) {
    const folderPath =
      ep.folder && ep.folder.length > 0
        ? ep.folder
        : [getEndpointPathGroup(ep.pathTemplate)];

    let node = root;
    for (const part of folderPath) {
      node = getOrCreateChild(node, part);
    }
    node.endpoints.push(ep);
  }

  function sortNode(n: NavFolderNode) {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.endpoints.sort((a, b) =>
      `${a.method} ${a.label}`.localeCompare(`${b.method} ${b.label}`)
    );
    for (const c of n.children) sortNode(c);
  }
  sortNode(root);

  return root;
}

export function countTreeEndpoints(node: NavFolderNode): number {
  return node.endpoints.length + node.children.reduce((s, c) => s + countTreeEndpoints(c), 0);
}

/* ── Catalog defaults ────────────────────────────────────────────── */

export function applyCatalogDefaults(input: {
  current: CreateRunFormState;
  moduleDefinition: ModuleCatalog;
  endpointDefinition?: ModuleEndpointCatalog | null;
}): CreateRunFormState {
  const ep = input.endpointDefinition ?? input.moduleDefinition.endpoints[0] ?? null;
  const cfg = asRecord(ep?.defaultRunConfig);
  const stopHttp = Array.isArray(cfg.stopOnHttpStatuses)
    ? cfg.stopOnHttpStatuses.join(",")
    : input.current.stopOnHttpStatuses;
  const env =
    (cfg.targetEnvironment as TargetEnvironment | undefined) ??
    input.moduleDefinition.defaultTargetEnvironment;

  const cfgQueryParams =
    cfg.queryParams && typeof cfg.queryParams === "object" && !Array.isArray(cfg.queryParams)
      ? (cfg.queryParams as Record<string, string>)
      : null;
  const queryParamRows: QueryParamRow[] = cfgQueryParams
    ? [...Object.entries(cfgQueryParams).map(([key, value]) => ({ key, value })), { key: "", value: "" }]
    : [{ key: "", value: "" }];

  const cfgHeaders =
    cfg.headers && typeof cfg.headers === "object" && !Array.isArray(cfg.headers)
      ? (cfg.headers as Record<string, string>)
      : null;
  const headerRows: QueryParamRow[] = cfgHeaders
    ? [...Object.entries(cfgHeaders).map(([key, value]) => ({ key, value })), { key: "", value: "" }]
    : [{ key: "", value: "" }];

  const cfgFormBody =
    cfg.formBody && typeof cfg.formBody === "object" && !Array.isArray(cfg.formBody)
      ? (cfg.formBody as Record<string, string>)
      : null;
  const formBodyRows: QueryParamRow[] = cfgFormBody
    ? [...Object.entries(cfgFormBody).map(([key, value]) => ({ key, value })), { key: "", value: "" }]
    : [{ key: "", value: "" }];

  const bodyType =
    typeof cfg.bodyType === "string" &&
    ["none", "json", "form", "multipart", "text"].includes(cfg.bodyType)
      ? (cfg.bodyType as "none" | "json" | "form" | "multipart" | "text")
      : input.current.bodyType;

  return {
    ...input.current,
    moduleSlug: input.moduleDefinition.slug,
    endpointSlug: ep?.slug ?? "",
    inputListId: "",
    idsRaw: "",
    tokenValues: {},
    label: input.current.label || ep?.defaultRunLabel || "",
    targetEnvironment: env,
    method: typeof cfg.method === "string" ? cfg.method : (ep?.method ?? "POST"),
    pathTemplate:
      typeof cfg.pathTemplate === "string"
        ? cfg.pathTemplate
        : ep?.pathTemplate ?? "/:id",
    queryParams: queryParamRows,
    headers: headerRows,
    bodyType,
    formBodyRows,
    requestBodyRaw:
      cfg.requestBody && typeof cfg.requestBody === "object"
        ? JSON.stringify(cfg.requestBody, null, 2)
        : "",
    dryRun: typeof cfg.dryRun === "boolean" ? cfg.dryRun : input.current.dryRun,
    concurrency:
      typeof cfg.concurrency === "number" ? cfg.concurrency : input.current.concurrency,
    minDelayMs: typeof cfg.minDelayMs === "number" ? cfg.minDelayMs : input.current.minDelayMs,
    maxRequestsPerMinute:
      typeof cfg.maxRequestsPerMinute === "number" ? String(cfg.maxRequestsPerMinute) : "",
    maxRetries: typeof cfg.maxRetries === "number" ? cfg.maxRetries : input.current.maxRetries,
    retryDelayMs:
      typeof cfg.retryDelayMs === "number" ? cfg.retryDelayMs : input.current.retryDelayMs,
    stopAfterFailures:
      typeof cfg.stopAfterFailures === "number" ? String(cfg.stopAfterFailures) : "",
    stopAfterConsecutiveFailures:
      typeof cfg.stopAfterConsecutiveFailures === "number"
        ? String(cfg.stopAfterConsecutiveFailures)
        : "",
    stopOnHttpStatuses: stopHttp,
    skipAuth: false,
    disabledDefaultHeaders: [],
    timeoutMs: typeof cfg.timeoutMs === "number" ? String(cfg.timeoutMs) : "",
    followRedirects: typeof cfg.followRedirects === "boolean" ? cfg.followRedirects : true,
  };
}

/* ── API / Hooks ─────────────────────────────────────────────────── */

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: "Request failed" }))) as {
      error?: string;
    };
    throw new Error(body.error ?? "Request failed");
  }
  return response.json() as Promise<T>;
}

export function usePolling(callback: () => void, enabled: boolean, delayMs: number): void {
  const onTick = useEffectEvent(callback);
  useEffect(() => {
    if (!enabled) return;
    onTick();
    const id = window.setInterval(() => onTick(), delayMs);
    return () => window.clearInterval(id);
  }, [delayMs, enabled, onTick]);
}
