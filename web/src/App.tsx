import { FormEvent, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

type RunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "STOPPED" | "FAILED";
type RunItemStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "STOPPED";
type TargetEnvironment = "staging" | "prod";

interface Tab {
  id: string;
  endpointSlug: string;
  moduleSlug: string;
  method: string;
  label: string;
  pinned: boolean;
}

interface RunSummary {
  id: string;
  slug: string | null;
  label: string | null;
  serviceName: string | null;
  action: string;
  moduleSlug: string | null;
  templateSlug: string | null;
  inputListId: string | null;
  status: RunStatus;
  totalItems: number;
  completedItems: number;
  succeededItems: number;
  failedItems: number;
  stopReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface RunEvent {
  id: string;
  runItemId: string | null;
  level: string;
  eventType: string;
  message: string;
  data: unknown;
  createdAt: string;
}

interface RunItem {
  id: string;
  sequence: number;
  itemValue: string;
  status: RunItemStatus;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  request: unknown;
  startedAt: string | null;
  finishedAt: string | null;
  response: unknown;
}

interface RunDetail extends RunSummary {
  config: Record<string, unknown>;
  stopRequestedAt: string | null;
  lastError: string | null;
  updatedAt: string;
  itemStatusBreakdown: Array<{ status: RunItemStatus; count: number }>;
  recentFailures: Array<{
    id: string;
    sequence: number;
    itemValue: string;
    attemptCount: number;
    lastHttpStatus: number | null;
    lastError: string | null;
    finishedAt: string | null;
  }>;
  recentEvents: RunEvent[];
}

interface QueryParamRow {
  key: string;
  value: string;
}

interface CreateRunFormState {
  moduleSlug: string;
  endpointSlug: string;
  inputListId: string;
  label: string;
  idsRaw: string;
  tokenValues: Record<string, string>;
  targetEnvironment: TargetEnvironment;
  method: string;
  pathTemplate: string;
  queryParams: QueryParamRow[];
  headers: QueryParamRow[];
  bodyType: "none" | "json" | "form" | "multipart" | "text";
  requestBodyRaw: string;
  formBodyRows: QueryParamRow[];
  dryRun: boolean;
  concurrency: number;
  minDelayMs: number;
  maxRequestsPerMinute: string;
  maxRetries: number;
  retryDelayMs: number;
  stopAfterFailures: string;
  stopAfterConsecutiveFailures: string;
  stopOnHttpStatuses: string;
}

interface ModuleEndpointCatalog {
  slug: string;
  action: string;
  label: string;
  description: string;
  method: string;
  pathTemplate: string;
  folder?: string[];
  requestBodyDescription?: string;
  notes?: string;
  defaultRunLabel?: string;
  defaultRunConfig?: Record<string, unknown> | null;
}

interface ModuleCatalog {
  slug: string;
  serviceName: string;
  label: string;
  description: string | null;
  defaultTargetEnvironment: TargetEnvironment;
  environments: Record<TargetEnvironment, { baseUrl: string }>;
  auth: {
    mode: "jwt";
    jwt: {
      email: string;
    };
  };
  defaultHeaders?: Record<string, string>;
  endpoints: ModuleEndpointCatalog[];
}

interface RuntimeConfig {
  defaultTargetEnvironment: TargetEnvironment;
  availableTargetEnvironments: TargetEnvironment[];
  authMode: "jwt" | "unconfigured";
  jwtEmail: string | null;
  serviceName: string;
  tokenCacheStrategy: "memory";
  targetBaseUrls: Record<TargetEnvironment, string>;
  modules: ModuleCatalog[];
}

interface SavedInputList {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  moduleSlug: string | null;
  itemType: string;
  itemCount: number;
  data: unknown;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

const defaultFormState: CreateRunFormState = {
  moduleSlug: "",
  endpointSlug: "",
  inputListId: "",
  label: "",
  idsRaw: "",
  tokenValues: {},
  targetEnvironment: "staging",
  method: "POST",
  pathTemplate: "/:id",
  queryParams: [{ key: "", value: "" }],
  headers: [{ key: "", value: "" }],
  bodyType: "json",
  requestBodyRaw: "",
  formBodyRows: [{ key: "", value: "" }],
  dryRun: true,
  concurrency: 1,
  minDelayMs: 250,
  maxRequestsPerMinute: "",
  maxRetries: 1,
  retryDelayMs: 1500,
  stopAfterFailures: "",
  stopAfterConsecutiveFailures: "",
  stopOnHttpStatuses: "401,403",
};

/* ── Helpers ──────────────────────────────────────────────────────── */

function formatDate(value: string | null): string {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value)
  );
}

function formatRuntime(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "Waiting";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}

function extractAllPathTokens(pathTemplate: string): string[] {
  const matches = pathTemplate.match(/:[a-z][a-z0-9_]*|\{[a-z][a-z0-9_]*\}/giu) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^[:{]|\}$/gu, "")))];
}

function parseIdList(raw: string): string[] {
  return raw.split(/[\s,]+/u).map((v) => v.trim()).filter(Boolean);
}

function applyEnvVars(template: string, vars: QueryParamRow[]): string {
  return vars
    .filter((v) => v.key.trim())
    .reduce((s, v) => s.replaceAll(`{{${v.key.trim()}}}`, v.value), template);
}

interface ParsedItemResponse {
  body: unknown;
  headers: Record<string, string>;
  size: number | null;
}

function parseItemResponse(raw: unknown): ParsedItemResponse {
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
    };
  }
  return { body: raw, headers: {}, size: null };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function syntaxHighlightJson(value: unknown): string {
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildPreviewUrl(input: {
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
    // Multi-token: substitute each token individually from tokenValues
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

function formatStructuredValue(value: unknown): string {
  if (value === null || value === undefined) return "No data";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatConfigValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined || value === "") return "Not set";
  return String(value);
}

function formatInputListData(data: unknown): string {
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

function getSelectedModule(modules: ModuleCatalog[], slug: string): ModuleCatalog | null {
  return modules.find((m) => m.slug === slug) ?? null;
}

function getSelectedEndpoint(
  mod: ModuleCatalog | null,
  slug: string
): ModuleEndpointCatalog | null {
  if (!mod) return null;
  return mod.endpoints.find((e) => e.slug === slug) ?? mod.endpoints[0] ?? null;
}

interface NavFolderNode {
  name: string;
  key: string;
  children: NavFolderNode[];
  endpoints: ModuleEndpointCatalog[];
}

function getEndpointPathGroup(pathTemplate: string): string {
  const normalized = pathTemplate.trim().startsWith("/")
    ? pathTemplate.trim()
    : `/${pathTemplate.trim()}`;
  const [first] = normalized.split("/").filter(Boolean);
  return first ? first : "misc";
}

function buildFolderTree(moduleKey: string, endpoints: ModuleEndpointCatalog[]): NavFolderNode {
  const root: NavFolderNode = { name: "", key: moduleKey, children: [], endpoints: [] };

  function getOrCreateChild(parent: NavFolderNode, name: string): NavFolderNode {
    let child = parent.children.find((c) => c.name === name);
    if (!child) {
      child = { name, key: `${parent.key}/${name}`, children: [], endpoints: [] };
      parent.children.push(child);
    }
    return child;
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

function applyCatalogDefaults(input: {
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
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
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

function usePolling(callback: () => void, enabled: boolean, delayMs: number): void {
  const onTick = useEffectEvent(callback);
  useEffect(() => {
    if (!enabled) return;
    onTick();
    const id = window.setInterval(() => onTick(), delayMs);
    return () => window.clearInterval(id);
  }, [delayMs, enabled, onTick]);
}

/* ── App ──────────────────────────────────────────────────────────── */

export function App() {
  /* state */
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [items, setItems] = useState<RunItem[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [inputLists, setInputLists] = useState<SavedInputList[]>([]);
  const [itemFilter, setItemFilter] = useState<RunItemStatus | "ALL">("ALL");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [formState, setFormState] = useState<CreateRunFormState>(defaultFormState);
  const [newInputListLabel, setNewInputListLabel] = useState("");
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingInputList, setSavingInputList] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [navSearch, setNavSearch] = useState("");
  const [workspaceTab, setWorkspaceTab] = useState<"params" | "body" | "headers" | "pacing">("params");
  const [responseTab, setResponseTab] = useState<"items" | "events" | "config">("items");
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [openModules, setOpenModules] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<"collections" | "history" | "input-lists" | "env" | "settings">("collections");
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [contextMenuEndpoint, setContextMenuEndpoint] = useState<{ slug: string; x: number; y: number } | null>(null);
  const [envVars, setEnvVars] = useState<QueryParamRow[]>(() => {
    try {
      const stored = localStorage.getItem("rav:env-vars");
      return stored ? (JSON.parse(stored) as QueryParamRow[]) : [{ key: "", value: "" }];
    } catch {
      return [{ key: "", value: "" }];
    }
  });
  const [requestPanelHeight, setRequestPanelHeight] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const resizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const requestPanelRef = useRef<HTMLDivElement>(null);

  /* data loading */
  async function loadRuntimeConfig() {
    try {
      const cfg = await requestJson<RuntimeConfig>("/api/config");
      setRuntimeConfig(cfg);
      const mod = cfg.modules[0];
      if (mod) {
        setFormState((cur) =>
          cur.moduleSlug && cfg.modules.some((m) => m.slug === cur.moduleSlug)
            ? cur
            : applyCatalogDefaults({
                current: { ...cur, targetEnvironment: cfg.defaultTargetEnvironment },
                moduleDefinition: mod,
              })
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runtime config");
    }
  }

  async function loadRuns() {
    try {
      const response = await requestJson<RunSummary[]>("/api/runs");
      setRuns((prev) =>
        JSON.stringify(prev) === JSON.stringify(response) ? prev : response
      );
    } catch {
      // Silently ignore — polling will retry on the next tick.
    }
  }

  async function loadInputLists() {
    try {
      setInputLists(await requestJson<SavedInputList[]>("/api/input-lists"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load input lists");
    }
  }

  async function loadRunDetail(runId: string) {
    try {
      const [detail, itemsRes, eventsRes] = await Promise.all([
        requestJson<RunDetail>(`/api/runs/${runId}`),
        requestJson<RunItem[]>(
          `/api/runs/${runId}/items${itemFilter === "ALL" ? "" : `?status=${itemFilter}`}`
        ),
        requestJson<RunEvent[]>(`/api/runs/${runId}/events`),
      ]);
      setRunDetail((prev) =>
        JSON.stringify(prev) === JSON.stringify(detail) ? prev : detail
      );
      setItems((prev) =>
        JSON.stringify(prev) === JSON.stringify(itemsRes) ? prev : itemsRes
      );
      setEvents((prev) =>
        JSON.stringify(prev) === JSON.stringify(eventsRes) ? prev : eventsRes
      );
      setError(null);
    } catch {
      // Silently ignore — polling will retry on the next tick.
    }
  }

  /* effects */
  useEffect(() => {
    void loadRuntimeConfig();
    void loadRuns();
    void loadInputLists();
  }, []);

  useEffect(() => {
    localStorage.setItem("rav:env-vars", JSON.stringify(envVars));
  }, [envVars]);

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null);
      setItems([]);
      setEvents([]);
      setSelectedItemId(null);
      return;
    }
    void loadRunDetail(selectedRunId);
  }, [selectedRunId, itemFilter]);

  useEffect(() => {
    if (items.length === 0) {
      setSelectedItemId(null);
      return;
    }
    setSelectedItemId((cur) => {
      if (cur && items.some((i) => i.id === cur)) return cur;
      return items.find((i) => i.status === "FAILED")?.id ?? items[0]?.id ?? null;
    });
  }, [items]);

  /* computed */
  const modules = runtimeConfig?.modules ?? [];
  const selectedModule = getSelectedModule(modules, formState.moduleSlug);
  const selectedEndpoint = getSelectedEndpoint(selectedModule, formState.endpointSlug);

  const navTreeByModule = useMemo(() => {
    const q = navSearch.toLowerCase();
    const result = new Map<string, NavFolderNode>();
    for (const mod of modules) {
      const filtered = q
        ? mod.endpoints.filter(
            (ep) =>
              ep.label.toLowerCase().includes(q) ||
              ep.pathTemplate.toLowerCase().includes(q) ||
              ep.method.toLowerCase().includes(q) ||
              ep.action.toLowerCase().includes(q)
          )
        : mod.endpoints;
      if (filtered.length > 0 || !q) {
        result.set(mod.slug, buildFolderTree(mod.slug, filtered));
      }
    }
    return result;
  }, [modules, navSearch]);

  // Count visible endpoints in a tree node (for search compat)
  function countTreeEndpoints(node: NavFolderNode): number {
    return node.endpoints.length + node.children.reduce((s, c) => s + countTreeEndpoints(c), 0);
  }

  const endpointRuns = useMemo(() => {
    if (!selectedEndpoint) return [];
    return runs.filter((r) => r.action === selectedEndpoint.action);
  }, [runs, selectedEndpoint]);

  const availableInputLists = useMemo(
    () =>
      inputLists.filter(
        (il) => !selectedModule || !il.moduleSlug || il.moduleSlug === selectedModule.slug
      ),
    [inputLists, selectedModule]
  );

  const shouldPoll = useMemo(
    () => Boolean(runDetail && (runDetail.status === "RUNNING" || runDetail.status === "PENDING")),
    [runDetail]
  );

  usePolling(
    () => {
      void loadRuns();
      if (selectedRunId) void loadRunDetail(selectedRunId);
    },
    shouldPoll || runs.length === 0,
    3000
  );

  const progressPercentage = runDetail
    ? Math.round((runDetail.completedItems / Math.max(runDetail.totalItems, 1)) * 100)
    : 0;
  const selectedItem = items.find((i) => i.id === selectedItemId) ?? null;
  const pathTokens = extractAllPathTokens(formState.pathTemplate);
  const isMultiToken = pathTokens.length > 1;
  const previewUrl = buildPreviewUrl({
    baseUrl: selectedModule?.environments[formState.targetEnvironment]?.baseUrl,
    pathTemplate: formState.pathTemplate,
    idsRaw: formState.idsRaw,
    tokenValues: formState.tokenValues,
    queryParams: formState.queryParams,
    envVars,
  });
  const idCount = isMultiToken
    ? Math.min(...pathTokens.map((t) => parseIdList(formState.tokenValues[t] ?? "").length))
    : parseIdList(formState.idsRaw).length;
  const idsLabel = pathTokens.length === 1
    ? pathTokens[0].replace(/_/gu, " ")
    : "IDs";
  const idsPlaceholder = pathTokens.length === 1
    ? `101, 204, 330 — one ${pathTokens[0]} per request`
    : "101, 204, 330 or newline separated";

  /* handlers */
  function toggleFolder(group: string) {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  // Auto-open all top-level folders on first load
  useEffect(() => {
    if (modules.length > 0 && openFolders.size === 0) {
      const keys = new Set<string>();
      for (const tree of navTreeByModule.values()) {
        for (const child of tree.children) keys.add(child.key);
      }
      if (keys.size > 0) setOpenFolders(keys);
    }
  }, [modules.length]);

  function clearRunState() {
    setSelectedRunId(null);
    setRunDetail(null);
    setItems([]);
    setEvents([]);
    setSelectedItemId(null);
    setError(null);
  }

  function activateEndpoint(endpoint: ModuleEndpointCatalog, mod?: ModuleCatalog) {
    const targetModule = mod ?? selectedModule;
    if (!targetModule) return;
    setFormState((cur) =>
      applyCatalogDefaults({
        current: { ...cur, label: "", idsRaw: "", inputListId: "" },
        moduleDefinition: targetModule,
        endpointDefinition: endpoint,
      })
    );
    clearRunState();
    setWorkspaceTab("params");
  }

  function handleSelectEndpoint(endpoint: ModuleEndpointCatalog, mod?: ModuleCatalog) {
    const targetModule = mod ?? selectedModule;
    if (!targetModule) return;

    // If this endpoint already has a tab, just activate it
    const existing = tabs.find(
      (t) => t.endpointSlug === endpoint.slug && t.moduleSlug === targetModule.slug
    );
    if (existing) {
      setActiveTabId(existing.id);
      activateEndpoint(endpoint, targetModule);
      return;
    }

    // Replace any unpinned (preview) tab, or add new preview tab
    const tabId = `${targetModule.slug}:${endpoint.slug}`;
    const newTab: Tab = {
      id: tabId,
      endpointSlug: endpoint.slug,
      moduleSlug: targetModule.slug,
      method: endpoint.method,
      label: endpoint.label,
      pinned: false,
    };

    setTabs((prev) => {
      const pinned = prev.filter((t) => t.pinned);
      return [...pinned, newTab];
    });
    setActiveTabId(tabId);
    activateEndpoint(endpoint, targetModule);
  }

  function handlePinTab(tabId: string) {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, pinned: true } : t)));
  }

  function handleCloseTab(tabId: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        // Activate the nearest remaining tab, or clear
        const closedIndex = prev.findIndex((t) => t.id === tabId);
        const fallback = next[Math.min(closedIndex, next.length - 1)] ?? null;
        if (fallback && selectedModule) {
          const ep = selectedModule.endpoints.find((e) => e.slug === fallback.endpointSlug);
          if (ep) {
            // Defer to avoid state conflicts within this setter
            setTimeout(() => {
              setActiveTabId(fallback.id);
              activateEndpoint(ep);
            }, 0);
          }
        } else {
          setTimeout(() => {
            setActiveTabId(null);
            clearRunState();
          }, 0);
        }
      }
      return next;
    });
  }

  function handleClickTab(tab: Tab) {
    if (activeTabId === tab.id) return;
    setActiveTabId(tab.id);
    if (!selectedModule) return;
    const ep = selectedModule.endpoints.find((e) => e.slug === tab.endpointSlug);
    if (ep) activateEndpoint(ep);
  }


  async function handleCreateRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Apply env var substitution helpers
      const ev = envVars.filter((v) => v.key.trim());
      const sub = (s: string) => applyEnvVars(s, ev);

      // Build body fields based on bodyType
      const bodyType = formState.bodyType;
      let requestBody: Record<string, unknown> | undefined;
      let formBody: Record<string, string> | undefined;
      let requestBodyText: string | undefined;

      if (bodyType === "json" && formState.requestBodyRaw.trim()) {
        try {
          requestBody = JSON.parse(sub(formState.requestBodyRaw)) as Record<string, unknown>;
        } catch {
          setError("Request body is not valid JSON");
          setSubmitting(false);
          return;
        }
      } else if (bodyType === "form" || bodyType === "multipart") {
        const fbEntries = formState.formBodyRows.filter((p) => p.key.trim());
        if (fbEntries.length > 0) {
          formBody = Object.fromEntries(fbEntries.map((p) => [p.key.trim(), sub(p.value)]));
        }
      } else if (bodyType === "text") {
        requestBodyText = sub(formState.requestBodyRaw);
      }

      const qpEntries = formState.queryParams.filter((p) => p.key.trim());
      const queryParams =
        qpEntries.length > 0
          ? Object.fromEntries(qpEntries.map((p) => [p.key.trim(), sub(p.value)]))
          : undefined;

      const hEntries = formState.headers.filter((p) => p.key.trim());
      const moduleDefaultHeaders = selectedModule?.defaultHeaders ?? {};
      const perRequestHeaders = Object.fromEntries(hEntries.map((p) => [p.key.trim(), sub(p.value)]));
      const mergedHeaders = { ...moduleDefaultHeaders, ...perRequestHeaders };
      const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;

      // Build itemValues from single token (idsRaw) or multi-token (tokenValues, zipped)
      const pathTokens = extractAllPathTokens(formState.pathTemplate);
      let itemValues: string[];
      if (pathTokens.length > 1) {
        const columns = pathTokens.map((t) => parseIdList(formState.tokenValues[t] ?? ""));
        const rowCount = Math.max(1, Math.min(...columns.map((c) => c.length)));
        itemValues = Array.from({ length: rowCount }, (_, i) => {
          const obj: Record<string, string> = {};
          for (const [ci, token] of pathTokens.entries()) {
            obj[token] = columns[ci][i] ?? "";
          }
          return JSON.stringify(obj);
        }).filter((v) => v !== "{}");
      } else {
        itemValues = parseIdList(formState.idsRaw).filter((id) => id !== "0");
      }

      const payload = {
        moduleSlug: formState.moduleSlug || undefined,
        endpointSlug: formState.endpointSlug || undefined,
        inputListId: formState.inputListId || undefined,
        label: formState.label || undefined,
        itemValues,
        targetEnvironment: formState.targetEnvironment,
        method: formState.method || undefined,
        pathTemplate: sub(formState.pathTemplate),
        queryParams,
        headers,
        bodyType,
        requestBody,
        formBody,
        requestBodyText,
        dryRun: formState.dryRun,
        concurrency: formState.concurrency,
        minDelayMs: formState.minDelayMs,
        maxRequestsPerMinute: formState.maxRequestsPerMinute
          ? Number.parseInt(formState.maxRequestsPerMinute, 10)
          : undefined,
        maxRetries: formState.maxRetries,
        retryDelayMs: formState.retryDelayMs,
        stopAfterFailures: formState.stopAfterFailures
          ? Number.parseInt(formState.stopAfterFailures, 10)
          : undefined,
        stopAfterConsecutiveFailures: formState.stopAfterConsecutiveFailures
          ? Number.parseInt(formState.stopAfterConsecutiveFailures, 10)
          : undefined,
        stopOnHttpStatuses: formState.stopOnHttpStatuses
          .split(/[\s,]+/u).map((v) => v.trim()).filter(Boolean)
          .map((v) => Number.parseInt(v, 10)).filter((v) => !Number.isNaN(v)),
      };
      const res = await requestJson<{ runId: string }>("/api/runs/http-request", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setFormState((cur) => ({ ...cur, label: "", idsRaw: "" }));
      await loadRuns();
      setSelectedRunId(res.runId);
      setResponseTab("items");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create run");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStopRun() {
    if (!selectedRunId) return;
    try {
      await requestJson(`/api/runs/${selectedRunId}/stop`, {
        method: "POST",
        body: JSON.stringify({ reason: "Stop requested from dashboard" }),
      });
      await loadRunDetail(selectedRunId);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop run");
    }
  }

  async function handleResumeRun() {
    if (!selectedRunId) return;
    try {
      await requestJson(`/api/runs/${selectedRunId}/resume`, { method: "POST" });
      await loadRunDetail(selectedRunId);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume run");
    }
  }

  async function handleSaveCurrentInputList() {
    const ids = parseIdList(formState.idsRaw);
    if (ids.length === 0) {
      setError("Add at least one ID before saving a list.");
      return;
    }
    setSavingInputList(true);
    setError(null);
    try {
      const created = await requestJson<SavedInputList>("/api/input-lists", {
        method: "POST",
        body: JSON.stringify({
          label: newInputListLabel.trim() || `${selectedModule?.label ?? "input"} list`,
          moduleSlug: formState.moduleSlug || undefined,
          itemType: "item_value",
          data: ids,
        }),
      });
      setFormState((cur) => ({ ...cur, inputListId: created.id }));
      setNewInputListLabel("");
      setSuccessMessage(`Saved "${created.label}" (${created.itemCount} items)`);
      setTimeout(() => setSuccessMessage(null), 4000);
      await loadInputLists();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save input list");
    } finally {
      setSavingInputList(false);
    }
  }

  async function handleRetryFailures() {
    if (!selectedRunId) return;
    try {
      const res = await requestJson<{ runId: string }>(
        `/api/runs/${selectedRunId}/retry-failures`,
        { method: "POST" }
      );
      await loadRuns();
      setSelectedRunId(res.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry failures");
    }
  }

  async function handleSaveFailuresAsList() {
    if (!selectedRunId) return;
    try {
      const created = await requestJson<SavedInputList>(
        `/api/runs/${selectedRunId}/failure-list`,
        { method: "POST" }
      );
      await loadInputLists();
      setFormState((cur) => ({
        ...cur,
        inputListId: created.id,
        idsRaw: formatInputListData(created.data),
      }));
      setSuccessMessage(`Failures saved as "${created.label}"`);
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save failures as a list");
    }
  }

  async function handleDeleteInputList(id: string) {
    try {
      await requestJson(`/api/input-lists/${id}`, { method: "DELETE" });
      await loadInputLists();
      if (formState.inputListId === id) {
        setFormState((cur) => ({ ...cur, inputListId: "" }));
      }
      setSuccessMessage("Input list deleted.");
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete input list");
    }
  }

  function handleLoadInputListIntoForm(il: SavedInputList) {
    setFormState((cur) => ({
      ...cur,
      inputListId: il.id,
      idsRaw: formatInputListData(il.data),
    }));
    setSidebarView("collections");
    setSuccessMessage(`Loaded "${il.label}" (${il.itemCount} items)`);
    setTimeout(() => setSuccessMessage(null), 3000);
  }

  const postmanFileRef = useRef<HTMLInputElement>(null);

  async function handleImportPostmanFile(file: File) {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await fetch("/api/modules/import-postman", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Import failed" }));
        setError((err as { error?: string }).error ?? "Import failed");
        return;
      }
      const result = (await res.json()) as { label: string; endpointCount: number; filename: string };
      // Reload runtime config to pick up the new module
      const cfg = await requestJson<RuntimeConfig>("/api/config");
      setRuntimeConfig(cfg);
      setSuccessMessage(`Imported "${result.label}" with ${result.endpointCount} endpoints → ${result.filename}`);
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import Postman collection");
    }
  }


  function handleNewTab() {
    if (!selectedModule) return;
    const ep = selectedModule.endpoints[0];
    if (!ep) return;
    handleSelectEndpoint(ep);
  }

  function handleSelectRunFromHistory(run: RunSummary) {
    // Find and activate the matching endpoint first
    if (selectedModule) {
      const ep = selectedModule.endpoints.find((e) => e.action === run.action);
      if (ep) {
        handleSelectEndpoint(ep);
      }
    }
    setSelectedRunId(run.id);
    setResponseTab("items");
    setSidebarView("collections");
  }

  function handleCopyAsCliCommand() {
    if (!selectedEndpoint) return;
    const ids = parseIdList(formState.idsRaw);
    const parts = ["yarn run"];
    if (ids.length > 0) parts.push(`--ids ${ids.join(",")}`);
    if (formState.dryRun) parts.push("--dry-run");
    if (formState.targetEnvironment !== "staging") parts.push(`--env ${formState.targetEnvironment}`);
    if (formState.concurrency > 1) parts.push(`--concurrency ${formState.concurrency}`);
    void navigator.clipboard.writeText(parts.join(" "));
    setSuccessMessage("CLI command copied to clipboard.");
    setTimeout(() => setSuccessMessage(null), 3000);
  }

  function formatItemDuration(item: RunItem): string | null {
    if (!item.startedAt) return null;
    const end = item.finishedAt ? new Date(item.finishedAt).getTime() : Date.now();
    const ms = end - new Date(item.startedAt).getTime();
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  function exportAsPostman(mod: ModuleCatalog) {
    const baseUrl = mod.environments[formState.targetEnvironment]?.baseUrl ?? "";
    const collection = {
      info: {
        name: mod.label,
        description: mod.description ?? "",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: mod.endpoints.map((ep) => ({
        name: ep.label,
        request: {
          method: ep.method,
          description: ep.description,
          header: [] as unknown[],
          url: {
            raw: `{{baseUrl}}${ep.pathTemplate}`,
            host: ["{{baseUrl}}"],
            path: ep.pathTemplate.replace(/^\//, "").split("/"),
          },
          body: ["POST", "PUT", "PATCH"].includes(ep.method)
            ? {
                mode: "raw",
                raw: ep.defaultRunConfig?.requestBody
                  ? JSON.stringify(ep.defaultRunConfig.requestBody, null, 2)
                  : "{}",
                options: { raw: { language: "json" } },
              }
            : undefined,
        },
      })),
      variable: [{ key: "baseUrl", value: baseUrl, type: "string" }],
    };
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${mod.slug}-collection.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleCopyPathTemplate(ep: ModuleEndpointCatalog) {
    void navigator.clipboard.writeText(ep.pathTemplate);
    setSuccessMessage(`Copied: ${ep.pathTemplate}`);
    setTimeout(() => setSuccessMessage(null), 3000);
    setContextMenuEndpoint(null);
  }

  function handleOpenInNewTab(ep: ModuleEndpointCatalog) {
    handleSelectEndpoint(ep);
    handlePinTab(`${selectedModule?.slug}:${ep.slug}`);
    setContextMenuEndpoint(null);
  }

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenuEndpoint) return;
    const handler = () => setContextMenuEndpoint(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [contextMenuEndpoint]);

  // Close send menu on outside click
  useEffect(() => {
    if (!sendMenuOpen) return;
    const handler = () => setSendMenuOpen(false);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [sendMenuOpen]);

  // Resize handle drag
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const panel = requestPanelRef.current;
    if (!panel) return;
    resizeDragRef.current = { startY: e.clientY, startHeight: panel.getBoundingClientRect().height };

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizeDragRef.current) return;
      const delta = ev.clientY - resizeDragRef.current.startY;
      const newHeight = Math.max(60, resizeDragRef.current.startHeight + delta);
      setRequestPanelHeight(newHeight);
    };
    const onMouseUp = () => {
      resizeDragRef.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  function flashCopied(msg = "Copied!") {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(null), 2000);
  }

  /* ── Render ────────────────────────────────────────────────────── */
  return (
    <div className="shell">
      {/* ── Icon Rail (far left) ──────────────────────────────────── */}
      <div className="icon-rail">
        <button className={`rail-btn ${sidebarView === "collections" ? "active" : ""}`} type="button" title="Collections" onClick={() => setSidebarView("collections")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        <button className={`rail-btn ${sidebarView === "history" ? "active" : ""}`} type="button" title="History" onClick={() => { setSidebarView("history"); void loadRuns(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </button>
        <button className={`rail-btn ${sidebarView === "input-lists" ? "active" : ""}`} type="button" title="Input Lists" onClick={() => { setSidebarView("input-lists"); void loadInputLists(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </button>
        <button className={`rail-btn ${sidebarView === "env" ? "active" : ""}`} type="button" title="Environment Variables" onClick={() => setSidebarView("env")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="2" />
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        </button>
        <div className="rail-spacer" />
        <button className={`rail-btn ${sidebarView === "settings" ? "active" : ""}`} type="button" title="Settings" onClick={() => setSidebarView("settings")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* ── Sidebar ────────────────────────────────────────────────── */}
      <div className="sidebar" style={{ width: sidebarWidth }}>
        <div
          className="sidebar-resize-handle"
          onMouseDown={(e) => {
            e.preventDefault();
            sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
            const onMove = (ev: MouseEvent) => {
              if (!sidebarDragRef.current) return;
              const delta = ev.clientX - sidebarDragRef.current.startX;
              const next = Math.max(180, Math.min(600, sidebarDragRef.current.startWidth + delta));
              setSidebarWidth(next);
            };
            const onUp = () => {
              sidebarDragRef.current = null;
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
              document.body.style.cursor = "";
              document.body.style.userSelect = "";
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
        />
        {sidebarView === "collections" ? (
          <>
            <div className="sidebar-header">
              <span className="sidebar-title">Collections</span>
              <div className="sidebar-actions">
                <input
                  ref={postmanFileRef}
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleImportPostmanFile(file);
                    e.target.value = "";
                  }}
                />
                {selectedModule ? (
                  <button
                    className="sidebar-action-btn"
                    type="button"
                    onClick={() => exportAsPostman(selectedModule)}
                  >Export</button>
                ) : null}
                <button
                  className="sidebar-action-btn"
                  type="button"
                  onClick={() => postmanFileRef.current?.click()}
                >Import</button>
              </div>
            </div>

            <div className="sidebar-search">
              <span className="sidebar-search-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <input
                placeholder="Filter endpoints..."
                value={navSearch}
                onChange={(e) => setNavSearch(e.target.value)}
              />
            </div>

            <div className="tree">
              {modules.map((mod) => {
                const modOpen = openModules.has(mod.slug);
                const modTree = navTreeByModule.get(mod.slug);
                if (navSearch && (!modTree || countTreeEndpoints(modTree) === 0)) return null;
                const isSelected = formState.moduleSlug === mod.slug;

                function renderFolderNode(node: NavFolderNode, depth: number): React.ReactNode {
                  const isOpen = openFolders.has(node.key);
                  const totalCount = countTreeEndpoints(node);
                  return (
                    <div className="tree-folder" key={node.key} style={{ "--folder-depth": depth } as React.CSSProperties}>
                      <button
                        className="tree-folder-header"
                        onClick={() => toggleFolder(node.key)}
                        type="button"
                      >
                        <span className={`tree-chevron ${isOpen ? "open" : ""}`}>&#9654;</span>
                        <span className="tree-folder-icon">&#128194;</span>
                        <span>{node.name}</span>
                        <span className="tree-folder-count">{totalCount}</span>
                      </button>
                      {isOpen ? (
                        <>
                          {node.children.map((child) => renderFolderNode(child, depth + 1))}
                          {node.endpoints.map((ep) => (
                            <button
                              className={`tree-item ${formState.moduleSlug === mod.slug && formState.endpointSlug === ep.slug ? "active" : ""}`}
                              key={ep.slug}
                              onClick={() => handleSelectEndpoint(ep, mod)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setContextMenuEndpoint({ slug: ep.slug, x: e.clientX, y: e.clientY });
                              }}
                              style={{ "--folder-depth": depth + 1 } as React.CSSProperties}
                              type="button"
                            >
                              <span className={`tree-item-method ${ep.method.toLowerCase()}`}>
                                {ep.method}
                              </span>
                              <span className="tree-item-label">{ep.label}</span>
                              <span className="tree-item-actions">
                                <span
                                  className="tree-item-action"
                                  title="More actions"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setContextMenuEndpoint({ slug: ep.slug, x: e.clientX, y: e.clientY });
                                  }}
                                >&hellip;</span>
                              </span>
                            </button>
                          ))}
                        </>
                      ) : null}
                    </div>
                  );
                }

                return (
                  <div className="tree-collection" key={mod.slug}>
                    <button
                      className={`tree-collection-header ${isSelected ? "active" : ""}`}
                      onClick={() =>
                        setOpenModules((prev) => {
                          const next = new Set(prev);
                          if (next.has(mod.slug)) next.delete(mod.slug);
                          else next.add(mod.slug);
                          return next;
                        })
                      }
                      type="button"
                    >
                      <span className={`tree-chevron ${modOpen ? "open" : ""}`}>&#9654;</span>
                      <span className="tree-folder-icon">&#128193;</span>
                      <span>{mod.label}</span>
                      <span className="tree-folder-count">{mod.endpoints.length}</span>
                    </button>

                    {modOpen && modTree
                      ? modTree.children.map((child) => renderFolderNode(child, 1))
                      : null}
                  </div>
                );
              })}

              {navSearch && [...navTreeByModule.values()].every((t) => countTreeEndpoints(t) === 0) ? (
                <p className="tree-empty">No endpoints match &ldquo;{navSearch}&rdquo;</p>
              ) : null}
            </div>

            {selectedModule ? (
              <div className="sidebar-footer">
                {selectedModule.endpoints.length} endpoints &middot; {selectedModule.serviceName}
              </div>
            ) : null}
          </>
        ) : sidebarView === "history" ? (
          <>
            <div className="sidebar-header">
              <span className="sidebar-title">History</span>
              <div className="sidebar-actions">
                <button className="sidebar-action-btn" type="button" onClick={() => void loadRuns()}>Refresh</button>
              </div>
            </div>
            <div className="tree">
              {runs.length > 0 ? (
                <div className="history-list">
                  {runs.map((run) => (
                    <button
                      className={`run-history-item ${selectedRunId === run.id ? "active" : ""}`}
                      key={run.id}
                      onClick={() => handleSelectRunFromHistory(run)}
                      type="button"
                    >
                      <div className="run-history-item-top">
                        <strong>{run.label ?? run.action}</strong>
                        <span className={`status-tag status-${run.status.toLowerCase()}`}>
                          {run.status.toLowerCase()}
                        </span>
                      </div>
                      <span className="run-history-item-meta">
                        {run.completedItems}/{run.totalItems} done &middot;{" "}
                        {run.failedItems} failed &middot; {formatDate(run.createdAt)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="tree-empty">No runs yet.</p>
              )}
            </div>
            <div className="sidebar-footer">
              {runs.length} runs
            </div>
          </>
        ) : sidebarView === "input-lists" ? (
          <>
            <div className="sidebar-header">
              <span className="sidebar-title">Input Lists</span>
              <div className="sidebar-actions">
                <button className="sidebar-action-btn" type="button" onClick={() => void loadInputLists()}>Refresh</button>
              </div>
            </div>
            <div className="tree">
              {inputLists.length > 0 ? (
                <div className="input-lists-list">
                  {inputLists.map((il) => (
                    <div className="input-list-card" key={il.id}>
                      <div className="input-list-card-top">
                        <strong>{il.label}</strong>
                        <span className="input-list-card-count">{il.itemCount} items</span>
                      </div>
                      {il.description ? (
                        <span className="input-list-card-desc">{il.description}</span>
                      ) : null}
                      <span className="input-list-card-meta">
                        {il.moduleSlug ?? "any module"} &middot; {formatDate(il.createdAt)}
                      </span>
                      <div className="input-list-card-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => handleLoadInputListIntoForm(il)}
                        >
                          Load
                        </button>
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(formatInputListData(il.data));
                            setSuccessMessage(`Copied ${il.itemCount} IDs.`);
                            setTimeout(() => setSuccessMessage(null), 3000);
                          }}
                        >
                          Copy
                        </button>
                        <button
                          className="ghost-button danger-text"
                          type="button"
                          onClick={() => void handleDeleteInputList(il.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="tree-empty">No saved input lists.</p>
              )}
            </div>
            <div className="sidebar-footer">
              {inputLists.length} lists
            </div>
          </>
        ) : sidebarView === "env" ? (
          <>
            <div className="sidebar-header">
              <span className="sidebar-title">Environment</span>
            </div>
            <div className="tree">
              <div className="settings-panel">
                <p className="env-vars-hint">
                  Define variables to use as <code>{"{{varName}}"}</code> in URLs, headers, query params, and request bodies. Saved to browser storage.
                </p>
                <div className="query-params-table">
                  {envVars.map((row, i) => (
                    <div key={i} className="query-param-row">
                      <input
                        className="query-param-key"
                        placeholder="Variable name"
                        value={row.key}
                        onChange={(e) => {
                          const next = envVars.map((r, j) =>
                            j === i ? { ...r, key: e.target.value } : r
                          );
                          const last = next[next.length - 1];
                          if (last.key || last.value) next.push({ key: "", value: "" });
                          setEnvVars(next);
                        }}
                      />
                      <input
                        className="query-param-value"
                        placeholder="Value"
                        value={row.value}
                        onChange={(e) => {
                          const next = envVars.map((r, j) =>
                            j === i ? { ...r, value: e.target.value } : r
                          );
                          const last = next[next.length - 1];
                          if (last.key || last.value) next.push({ key: "", value: "" });
                          setEnvVars(next);
                        }}
                      />
                      {(row.key || row.value) ? (
                        <button
                          type="button"
                          className="remove-param-btn"
                          onClick={() => setEnvVars((cur) => cur.filter((_, j) => j !== i))}
                        >×</button>
                      ) : <span className="remove-param-btn" />}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="sidebar-footer">
              {envVars.filter((v) => v.key.trim()).length} variables active
            </div>
          </>
        ) : (
          <>
            <div className="sidebar-header">
              <span className="sidebar-title">Settings</span>
            </div>
            <div className="tree">
              <div className="settings-panel">
                <div className="settings-group">
                  <span className="settings-label">Service</span>
                  <span className="settings-value">{runtimeConfig?.serviceName ?? "—"}</span>
                </div>
                <div className="settings-group">
                  <span className="settings-label">Auth mode</span>
                  <span className="settings-value">{runtimeConfig?.authMode ?? "—"}</span>
                </div>
                {runtimeConfig?.jwtEmail ? (
                  <div className="settings-group">
                    <span className="settings-label">JWT email</span>
                    <span className="settings-value">{runtimeConfig.jwtEmail}</span>
                  </div>
                ) : null}
                <div className="settings-group">
                  <span className="settings-label">Environment</span>
                  <span className="settings-value">{formState.targetEnvironment}</span>
                </div>
                {runtimeConfig?.targetBaseUrls ? (
                  <>
                    {Object.entries(runtimeConfig.targetBaseUrls).map(([env, url]) => (
                      <div className="settings-group" key={env}>
                        <span className="settings-label">{env} URL</span>
                        <span className="settings-value settings-url">{url}</span>
                      </div>
                    ))}
                  </>
                ) : null}
                <div className="settings-group">
                  <span className="settings-label">Token cache</span>
                  <span className="settings-value">{runtimeConfig?.tokenCacheStrategy ?? "—"}</span>
                </div>
                <div className="settings-group">
                  <span className="settings-label">Modules</span>
                  <span className="settings-value">{modules.length}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Context menu for tree items */}
      {contextMenuEndpoint && selectedModule ? (() => {
        const ep = selectedModule.endpoints.find((e) => e.slug === contextMenuEndpoint.slug);
        if (!ep) return null;
        return (
          <div className="context-menu" style={{ top: contextMenuEndpoint.y, left: contextMenuEndpoint.x }}>
            <button type="button" onClick={() => handleOpenInNewTab(ep)}>Open &amp; pin tab</button>
            <button type="button" onClick={() => handleCopyPathTemplate(ep)}>Copy path template</button>
            <button type="button" onClick={() => {
              void navigator.clipboard.writeText(`${selectedModule.environments[formState.targetEnvironment]?.baseUrl ?? ""}${ep.pathTemplate}`);
              setSuccessMessage("Full URL copied.");
              setTimeout(() => setSuccessMessage(null), 3000);
              setContextMenuEndpoint(null);
            }}>Copy full URL</button>
          </div>
        );
      })() : null}

      {/* ── Workspace ─────────────────────────────────────────────── */}
      <main className="workspace">
        {/* Tab strip (open request tabs) */}
        <div className="tab-strip">
          {tabs.map((tab) => (
            <button
              className={`tab-strip-item ${activeTabId === tab.id ? "active" : ""} ${tab.pinned ? "pinned" : "preview"}`}
              key={tab.id}
              onClick={() => handleClickTab(tab)}
              onDoubleClick={() => handlePinTab(tab.id)}
              type="button"
            >
              <span className={`tab-strip-method ${tab.method.toLowerCase()}`}>
                {tab.method}
              </span>
              <span className="tab-label">{tab.label}</span>
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.id);
                }}
              >
                &times;
              </span>
            </button>
          ))}
          {tabs.length === 0 ? (
            <span className="tab-strip-empty">No open tabs</span>
          ) : null}
          <button className="tab-strip-new" type="button" title="New tab" onClick={handleNewTab}>+</button>
          <div className="env-selector">
            <span className="env-selector-label">Env</span>
            <select
              value={formState.targetEnvironment}
              onChange={(e) =>
                setFormState((cur) => ({
                  ...cur,
                  targetEnvironment: e.target.value as TargetEnvironment,
                }))
              }
            >
              {(runtimeConfig?.availableTargetEnvironments ?? ["staging", "prod"]).map(
                (t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                )
              )}
            </select>
          </div>
        </div>

        {/* Banners */}
        {error ? (
          <div className="ws-banner error-banner">
            <span>{error}</span>
            <button className="banner-dismiss" type="button" onClick={() => setError(null)}>&times;</button>
          </div>
        ) : null}
        {successMessage ? (
          <div className="ws-banner success-banner">
            <span>{successMessage}</span>
            <button className="banner-dismiss" type="button" onClick={() => setSuccessMessage(null)}>&times;</button>
          </div>
        ) : null}

        {selectedEndpoint ? (
          <>
            {/* URL bar */}
            <form className="url-bar" onSubmit={handleCreateRun}>
              <select
                className={`url-method-select ${formState.method.toLowerCase()}`}
                value={formState.method}
                onChange={(e) =>
                  setFormState((cur) => ({ ...cur, method: e.target.value }))
                }
              >
                {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <div className="url-input-group">
                {selectedModule?.environments[formState.targetEnvironment]?.baseUrl ? (
                  <span
                    className="url-base-prefix"
                    onClick={() => { void navigator.clipboard.writeText(previewUrl); flashCopied("URL copied!"); }}
                    title="Click to copy full URL"
                  >
                    {selectedModule.environments[formState.targetEnvironment].baseUrl}
                  </span>
                ) : null}
                <input
                  className="url-path-input"
                  value={
                    formState.pathTemplate +
                    (() => {
                      const active = formState.queryParams.filter((p) => p.key.trim());
                      return active.length > 0
                        ? "?" + active.map((p) => `${p.key}=${p.value}`).join("&")
                        : "";
                    })()
                  }
                  onChange={(e) => {
                    const raw = e.target.value;
                    const qIdx = raw.indexOf("?");
                    const newPath = qIdx === -1 ? raw : raw.slice(0, qIdx);
                    const qs = qIdx === -1 ? "" : raw.slice(qIdx + 1);
                    const parsedParams: QueryParamRow[] = qs
                      ? qs.split("&").map((part) => {
                          const eqIdx = part.indexOf("=");
                          return eqIdx === -1
                            ? { key: part, value: "" }
                            : { key: part.slice(0, eqIdx), value: part.slice(eqIdx + 1) };
                        })
                      : [];
                    parsedParams.push({ key: "", value: "" });
                    setFormState((cur) => ({
                      ...cur,
                      pathTemplate: newPath,
                      tokenValues: newPath !== cur.pathTemplate ? {} : cur.tokenValues,
                      idsRaw: newPath !== cur.pathTemplate ? "" : cur.idsRaw,
                      queryParams: parsedParams,
                    }));
                  }}
                  placeholder="/path/:token"
                  spellCheck={false}
                />
              </div>
              <div className="url-extras">
                <label className="url-toggle">
                  <input
                    type="checkbox"
                    checked={formState.dryRun}
                    onChange={(e) =>
                      setFormState((cur) => ({ ...cur, dryRun: e.target.checked }))
                    }
                  />
                  <span>Dry run</span>
                </label>
              </div>
              <div className="send-button-group">
                <button
                  className="send-button-main"
                  disabled={submitting || (pathTokens.length > 0 && idCount === 0 && !formState.inputListId)}
                  type="submit"
                >
                  {submitting ? "Sending..." : "Send"}
                </button>
                <span
                  className="send-button-drop"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSendMenuOpen((v) => !v);
                  }}
                >&#9662;</span>
                {sendMenuOpen ? (
                  <div className="send-dropdown">
                    <button
                      type="button"
                      onClick={() => {
                        setFormState((cur) => ({ ...cur, dryRun: false }));
                        setSendMenuOpen(false);
                        const form = document.querySelector<HTMLFormElement>(".url-bar");
                        if (form) form.requestSubmit();
                      }}
                      disabled={submitting || (pathTokens.length > 0 && idCount === 0 && !formState.inputListId)}
                    >
                      Send (live)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setFormState((cur) => ({ ...cur, dryRun: true }));
                        setSendMenuOpen(false);
                        const form = document.querySelector<HTMLFormElement>(".url-bar");
                        if (form) form.requestSubmit();
                      }}
                      disabled={submitting || (pathTokens.length > 0 && idCount === 0 && !formState.inputListId)}
                    >
                      Send (dry run)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleCopyAsCliCommand();
                        setSendMenuOpen(false);
                      }}
                    >
                      Copy as CLI
                    </button>
                  </div>
                ) : null}
              </div>
            </form>

            {/* Request sub-tabs */}
            <div className="request-tabs">
              <button
                className={workspaceTab === "params" ? "active" : ""}
                onClick={() => setWorkspaceTab("params")}
                type="button"
              >
                Params
              </button>
              <button
                className={workspaceTab === "body" ? "active" : ""}
                onClick={() => setWorkspaceTab("body")}
                type="button"
              >
                Body{formState.bodyType !== "none" && (formState.requestBodyRaw.trim() || formState.formBodyRows.some((r) => r.key.trim())) ? " •" : ""}
              </button>
              <button
                className={workspaceTab === "headers" ? "active" : ""}
                onClick={() => setWorkspaceTab("headers")}
                type="button"
              >
                Headers{formState.headers.filter((h) => h.key.trim()).length > 0 ? ` (${formState.headers.filter((h) => h.key.trim()).length})` : ""}
              </button>
              <button
                className={workspaceTab === "pacing" ? "active" : ""}
                onClick={() => setWorkspaceTab("pacing")}
                type="button"
              >
                Pacing
              </button>
            </div>

            {/* Request panel content */}
            <div className="request-panel" ref={requestPanelRef} style={requestPanelHeight ? { height: requestPanelHeight, overflow: "auto" } : undefined}>
              {selectedEndpoint.description ? (
                <p className="endpoint-desc">{selectedEndpoint.description}</p>
              ) : null}
              {selectedEndpoint.notes ? (
                <p className="endpoint-notes">{selectedEndpoint.notes}</p>
              ) : null}

              {workspaceTab === "headers" ? (
                <div className="params-content">
                  <div className="query-params-section">
                    <span className="section-label">Request headers <span className="section-label-hint">Use <code>{"{{itemValue}}"}</code> to inject the current item</span></span>
                    <div className="query-params-table">
                      {formState.headers.map((row, i) => (
                        <div key={i} className="query-param-row">
                          <input
                            className="query-param-key"
                            placeholder="Header name"
                            value={row.key}
                            onChange={(e) => {
                              const next = formState.headers.map((r, j) =>
                                j === i ? { ...r, key: e.target.value } : r
                              );
                              const last = next[next.length - 1];
                              if (last.key || last.value) next.push({ key: "", value: "" });
                              setFormState((cur) => ({ ...cur, headers: next }));
                            }}
                          />
                          <input
                            className="query-param-value"
                            placeholder="Value"
                            value={row.value}
                            onChange={(e) => {
                              const next = formState.headers.map((r, j) =>
                                j === i ? { ...r, value: e.target.value } : r
                              );
                              const last = next[next.length - 1];
                              if (last.key || last.value) next.push({ key: "", value: "" });
                              setFormState((cur) => ({ ...cur, headers: next }));
                            }}
                          />
                          {(row.key || row.value) ? (
                            <button
                              type="button"
                              className="remove-param-btn"
                              onClick={() =>
                                setFormState((cur) => ({
                                  ...cur,
                                  headers: cur.headers.filter((_, j) => j !== i)
                                }))
                              }
                            >×</button>
                          ) : <span className="remove-param-btn" />}
                        </div>
                      ))}
                    </div>
                    <p className="section-hint">Authorization and Content-Type are set automatically. Per-request headers override collection headers.</p>
                  </div>

                  {selectedModule?.defaultHeaders && Object.keys(selectedModule.defaultHeaders).length > 0 ? (
                    <div className="query-params-section">
                      <span className="section-label">Collection headers <span className="section-label-hint">Inherited from {selectedModule.label} — override above</span></span>
                      <div className="query-params-table">
                        {Object.entries(selectedModule.defaultHeaders).map(([key, value]) => (
                          <div key={key} className="query-param-row collection-header-row">
                            <input className="query-param-key" value={key} readOnly tabIndex={-1} />
                            <input className="query-param-value" value={value} readOnly tabIndex={-1} />
                            <span className="remove-param-btn" />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : workspaceTab === "params" ? (
                <div className="params-content">
                  <div className="params-row">
                    <label className="param-field">
                      <span>Run label</span>
                      <input
                        value={formState.label}
                        onChange={(e) =>
                          setFormState((cur) => ({ ...cur, label: e.target.value }))
                        }
                        placeholder={selectedEndpoint.defaultRunLabel ?? "Optional label"}
                      />
                    </label>
                    <label className="param-field">
                      <span>Saved input list</span>
                      <select
                        value={formState.inputListId}
                        onChange={(e) => {
                          const il = availableInputLists.find((x) => x.id === e.target.value);
                          if (!il) {
                            setFormState((cur) => ({ ...cur, inputListId: "" }));
                            return;
                          }
                          setFormState((cur) => ({
                            ...cur,
                            inputListId: il.id,
                            idsRaw: formatInputListData(il.data),
                          }));
                        }}
                      >
                        <option value="">None</option>
                        {availableInputLists.map((il) => (
                          <option key={il.id} value={il.id}>
                            {il.label} ({il.itemCount})
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="query-params-section">
                    <span className="section-label">Query params <span className="section-label-hint">Use <code>{"{{itemValue}}"}</code> in values to inject the current item</span></span>
                    <div className="query-params-table">
                      {formState.queryParams.map((row, i) => (
                        <div key={i} className="query-param-row">
                          <input
                            className="query-param-key"
                            placeholder="Key"
                            value={row.key}
                            onChange={(e) => {
                              const next = formState.queryParams.map((r, j) =>
                                j === i ? { ...r, key: e.target.value } : r
                              );
                              // auto-add trailing empty row
                              const last = next[next.length - 1];
                              if (last.key || last.value) next.push({ key: "", value: "" });
                              setFormState((cur) => ({ ...cur, queryParams: next }));
                            }}
                          />
                          <input
                            className="query-param-value"
                            placeholder="Value"
                            value={row.value}
                            onChange={(e) => {
                              const next = formState.queryParams.map((r, j) =>
                                j === i ? { ...r, value: e.target.value } : r
                              );
                              const last = next[next.length - 1];
                              if (last.key || last.value) next.push({ key: "", value: "" });
                              setFormState((cur) => ({ ...cur, queryParams: next }));
                            }}
                          />
                          {(row.key || row.value) ? (
                            <button
                              type="button"
                              className="remove-param-btn"
                              onClick={() =>
                                setFormState((cur) => ({
                                  ...cur,
                                  queryParams: cur.queryParams.filter((_, j) => j !== i)
                                }))
                              }
                            >×</button>
                          ) : <span className="remove-param-btn" />}
                        </div>
                      ))}
                    </div>
                  </div>

                  {isMultiToken ? (
                    <div className="ids-section">
                      <span className="section-label">Path values{idCount > 0 ? ` (${idCount} rows)` : ""}</span>
                      {pathTokens.map((token) => {
                        const vals = formState.tokenValues[token] ?? "";
                        const count = parseIdList(vals).length;
                        return (
                          <label key={token} className="param-field param-field-grow">
                            <span>{token.replace(/_/gu, " ")}{count > 0 ? ` (${count})` : ""}</span>
                            <textarea
                              rows={3}
                              value={vals}
                              onChange={(e) =>
                                setFormState((cur) => ({
                                  ...cur,
                                  inputListId: "",
                                  tokenValues: { ...cur.tokenValues, [token]: e.target.value },
                                }))
                              }
                              placeholder={`101, 204, 330 — one ${token} per request`}
                            />
                          </label>
                        );
                      })}
                      <p className="section-hint">Each row position is matched across tokens — request 1 gets row 1 of each, etc.</p>
                    </div>
                  ) : (
                    <div className="ids-section">
                      <label className="param-field param-field-grow">
                        <span>{idsLabel}{idCount > 0 ? ` (${idCount})` : ""}</span>
                        <textarea
                          rows={4}
                          value={formState.idsRaw}
                          onChange={(e) =>
                            setFormState((cur) => ({
                              ...cur,
                              inputListId: "",
                              idsRaw: e.target.value,
                            }))
                          }
                          placeholder={idsPlaceholder}
                        />
                      </label>
                      {idCount > 0 ? (
                        <div className="save-ids-row">
                          <input
                            value={newInputListLabel}
                            onChange={(e) => setNewInputListLabel(e.target.value)}
                            placeholder="List label"
                          />
                          <button
                            className="ghost-button"
                            disabled={savingInputList}
                            onClick={() => void handleSaveCurrentInputList()}
                            type="button"
                          >
                            {savingInputList ? "Saving..." : "Save as list"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )}

                </div>
              ) : workspaceTab === "body" ? (
                <div className="params-content">
                  <div className="body-type-row">
                    <span className="section-label">Body type</span>
                    <div className="body-type-buttons">
                      {(["none", "json", "form", "multipart", "text"] as const).map((bt) => (
                        <button
                          key={bt}
                          type="button"
                          className={`body-type-btn${formState.bodyType === bt ? " active" : ""}`}
                          onClick={() => setFormState((cur) => ({ ...cur, bodyType: bt }))}
                        >
                          {bt === "multipart" ? "multipart" : bt}
                        </button>
                      ))}
                    </div>
                  </div>

                  {formState.bodyType === "none" ? (
                    <p className="section-hint body-none-hint">No body will be sent with this request.</p>
                  ) : formState.bodyType === "form" || formState.bodyType === "multipart" ? (
                    <div className="query-params-section">
                      <span className="section-label">
                        {formState.bodyType === "multipart" ? "Form fields (multipart/form-data)" : "Form fields (x-www-form-urlencoded)"}
                        <span className="section-label-hint"> — Use <code>{"{{itemValue}}"}</code> or <code>{"{{varName}}"}</code> in values</span>
                      </span>
                      <div className="query-params-table">
                        {formState.formBodyRows.map((row, i) => (
                          <div key={i} className="query-param-row">
                            <input
                              className="query-param-key"
                              placeholder="Field name"
                              value={row.key}
                              onChange={(e) => {
                                const next = formState.formBodyRows.map((r, j) =>
                                  j === i ? { ...r, key: e.target.value } : r
                                );
                                const last = next[next.length - 1];
                                if (last.key || last.value) next.push({ key: "", value: "" });
                                setFormState((cur) => ({ ...cur, formBodyRows: next }));
                              }}
                            />
                            <input
                              className="query-param-value"
                              placeholder="Value"
                              value={row.value}
                              onChange={(e) => {
                                const next = formState.formBodyRows.map((r, j) =>
                                  j === i ? { ...r, value: e.target.value } : r
                                );
                                const last = next[next.length - 1];
                                if (last.key || last.value) next.push({ key: "", value: "" });
                                setFormState((cur) => ({ ...cur, formBodyRows: next }));
                              }}
                            />
                            {(row.key || row.value) ? (
                              <button
                                type="button"
                                className="remove-param-btn"
                                onClick={() =>
                                  setFormState((cur) => ({
                                    ...cur,
                                    formBodyRows: cur.formBodyRows.filter((_, j) => j !== i),
                                  }))
                                }
                              >×</button>
                            ) : <span className="remove-param-btn" />}
                          </div>
                        ))}
                      </div>
                      <p className="section-hint">
                        {formState.bodyType === "multipart"
                          ? "Sent as multipart/form-data. Content-Type boundary is set automatically."
                          : "Sent as application/x-www-form-urlencoded."}
                      </p>
                    </div>
                  ) : (
                    <label className="param-field">
                      <span>
                        {formState.bodyType === "text" ? "Plain text body" : "JSON body"}
                        {selectedEndpoint.requestBodyDescription ? ` — ${selectedEndpoint.requestBodyDescription}` : ""}
                        <span className="section-label-hint"> — Use <code>{"{{itemValue}}"}</code> or <code>{"{{varName}}"}</code></span>
                      </span>
                      <textarea
                        rows={10}
                        value={formState.requestBodyRaw}
                        onChange={(e) =>
                          setFormState((cur) => ({ ...cur, requestBodyRaw: e.target.value }))
                        }
                        placeholder={
                          formState.bodyType === "text"
                            ? `Plain text body\n\nUse {{itemValue}} to inject the current item`
                            : `{\n  "key": "value",\n  "id": "{{itemValue}}"\n}\n\nLeave empty to use default { dry_run } body`
                        }
                        style={{ fontFamily: "monospace", fontSize: "0.8rem" }}
                      />
                    </label>
                  )}
                </div>
              ) : (
                <div className="pacing-grid">
                  <label className="param-field">
                    <span>Concurrency</span>
                    <input
                      type="number"
                      min={1}
                      value={formState.concurrency}
                      onChange={(e) =>
                        setFormState((cur) => ({
                          ...cur,
                          concurrency: Number.parseInt(e.target.value, 10) || 1,
                        }))
                      }
                    />
                  </label>
                  <label className="param-field">
                    <span>Min delay ms</span>
                    <input
                      type="number"
                      min={0}
                      value={formState.minDelayMs}
                      onChange={(e) =>
                        setFormState((cur) => ({
                          ...cur,
                          minDelayMs: Number.parseInt(e.target.value, 10) || 0,
                        }))
                      }
                    />
                  </label>
                  <label className="param-field">
                    <span>Max requests / min</span>
                    <input
                      value={formState.maxRequestsPerMinute}
                      onChange={(e) =>
                        setFormState((cur) => ({ ...cur, maxRequestsPerMinute: e.target.value }))
                      }
                      placeholder="Unlimited"
                    />
                  </label>
                  <label className="param-field">
                    <span>Max retries</span>
                    <input
                      type="number"
                      min={0}
                      value={formState.maxRetries}
                      onChange={(e) =>
                        setFormState((cur) => ({
                          ...cur,
                          maxRetries: Number.parseInt(e.target.value, 10) || 0,
                        }))
                      }
                    />
                  </label>
                  <label className="param-field">
                    <span>Retry delay ms</span>
                    <input
                      type="number"
                      min={0}
                      value={formState.retryDelayMs}
                      onChange={(e) =>
                        setFormState((cur) => ({
                          ...cur,
                          retryDelayMs: Number.parseInt(e.target.value, 10) || 0,
                        }))
                      }
                    />
                  </label>
                  <label className="param-field">
                    <span>Stop after failures</span>
                    <input
                      value={formState.stopAfterFailures}
                      onChange={(e) =>
                        setFormState((cur) => ({ ...cur, stopAfterFailures: e.target.value }))
                      }
                      placeholder="No limit"
                    />
                  </label>
                  <label className="param-field">
                    <span>Stop after consecutive</span>
                    <input
                      value={formState.stopAfterConsecutiveFailures}
                      onChange={(e) =>
                        setFormState((cur) => ({
                          ...cur,
                          stopAfterConsecutiveFailures: e.target.value,
                        }))
                      }
                      placeholder="No limit"
                    />
                  </label>
                  <label className="param-field">
                    <span>Stop on HTTP codes</span>
                    <input
                      value={formState.stopOnHttpStatuses}
                      onChange={(e) =>
                        setFormState((cur) => ({ ...cur, stopOnHttpStatuses: e.target.value }))
                      }
                      placeholder="401,403,500"
                    />
                  </label>
                </div>
              )}
            </div>

            {/* Resize handle */}
            <div className="resize-handle" onMouseDown={handleResizeMouseDown} />
            <div className="response-label">Response</div>

            {/* ── Response area (bottom half) ─────────────────────── */}
            <div className="response-area">
              {runDetail ? (
                <>
                  {/* Response header with tabs + status */}
                  <div className="response-header">
                    <div className="response-tabs">
                      <button
                        className={responseTab === "items" ? "active" : ""}
                        onClick={() => setResponseTab("items")}
                        type="button"
                      >
                        Results
                      </button>
                      <button
                        className={responseTab === "events" ? "active" : ""}
                        onClick={() => setResponseTab("events")}
                        type="button"
                      >
                        Events ({events.length})
                      </button>
                      <button
                        className={responseTab === "config" ? "active" : ""}
                        onClick={() => setResponseTab("config")}
                        type="button"
                      >
                        Config
                      </button>
                    </div>
                    <div className="response-meta">
                      <span
                        className={`response-status-badge ${
                          runDetail.status === "COMPLETED"
                            ? "success"
                            : runDetail.status === "FAILED" || runDetail.status === "STOPPED"
                              ? "error"
                              : "warn"
                        }`}
                      >
                        {runDetail.status}
                      </span>
                      <span className="response-meta-text">
                        {progressPercentage}% &middot; {runDetail.succeededItems} ok &middot;{" "}
                        {runDetail.failedItems} fail &middot;{" "}
                        {formatRuntime(runDetail.startedAt, runDetail.finishedAt)}
                      </span>
                      <div className="run-results-actions">
                        {runDetail.failedItems > 0 &&
                        (runDetail.status === "COMPLETED" ||
                          runDetail.status === "STOPPED" ||
                          runDetail.status === "FAILED") ? (
                          <>
                            <button
                              className="ghost-button"
                              onClick={() => void handleRetryFailures()}
                              type="button"
                            >
                              Retry
                            </button>
                            <button
                              className="ghost-button"
                              onClick={() => void handleSaveFailuresAsList()}
                              type="button"
                            >
                              Save failures
                            </button>
                          </>
                        ) : null}
                        {runDetail.status === "STOPPED" ? (
                          <button
                            className="ghost-button"
                            onClick={() => void handleResumeRun()}
                            type="button"
                          >
                            Resume
                          </button>
                        ) : null}
                        {runDetail.status === "RUNNING" || runDetail.status === "PENDING" ? (
                          <button
                            className="danger-button"
                            onClick={() => void handleStopRun()}
                            type="button"
                          >
                            Stop
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="progress-line">
                    <div className="progress-fill" style={{ width: `${progressPercentage}%` }} />
                  </div>

                  {runDetail.stopReason || runDetail.lastError ? (
                    <div className="run-alert">
                      {runDetail.stopReason ? (
                        <p>
                          <strong>Stop reason:</strong> {runDetail.stopReason}
                        </p>
                      ) : null}
                      {runDetail.lastError ? (
                        <p>
                          <strong>Last error:</strong> {runDetail.lastError}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Response body content */}
                  <div className="response-body">
                    {responseTab === "items" ? (
                      <div className="items-section">
                        <div className="items-filter-bar">
                          <div className="segmented">
                            {(
                              ["ALL", "PENDING", "RUNNING", "SUCCEEDED", "FAILED", "STOPPED"] as const
                            ).map((s) => (
                              <button
                                className={itemFilter === s ? "active" : ""}
                                key={s}
                                onClick={() => setItemFilter(s)}
                                type="button"
                              >
                                {s.toLowerCase()}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="items-detail-grid">
                          <div className="table-wrap">
                            <table className="compact-table">
                              <thead>
                                <tr>
                                  {[
                                    { label: "Seq", accessor: (i: RunItem) => String(i.sequence) },
                                    { label: "ID", accessor: (i: RunItem) => i.itemValue },
                                    { label: "Status", accessor: (i: RunItem) => i.status.toLowerCase() },
                                    { label: "HTTP", accessor: (i: RunItem) => String(i.lastHttpStatus ?? "") },
                                    { label: "Time", accessor: (i: RunItem) => formatItemDuration(i) ?? "" },
                                    { label: "Error", accessor: (i: RunItem) => i.lastError ?? "" },
                                  ].map((col) => (
                                    <th key={col.label}>
                                      <span className="th-content">
                                        {col.label}
                                        <button
                                          type="button"
                                          className="copy-col-btn"
                                          title={`Copy all ${col.label} values`}
                                          onClick={() => {
                                            const text = items.map(col.accessor).filter(Boolean).join(", ");
                                            void navigator.clipboard.writeText(text);
                                          }}
                                        >
                                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                          </svg>
                                        </button>
                                      </span>
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {items.map((item) => (
                                  <tr
                                    className={selectedItemId === item.id ? "active-row" : ""}
                                    key={item.id}
                                    onClick={() => setSelectedItemId(item.id)}
                                  >
                                    <td>{item.sequence}</td>
                                    <td>{item.itemValue}</td>
                                    <td>
                                      <span
                                        className={`status-tag status-${item.status.toLowerCase()}`}
                                      >
                                        {item.status.toLowerCase()}
                                      </span>
                                    </td>
                                    <td>{item.lastHttpStatus ?? "\u2013"}</td>
                                    <td className="dim-cell">{formatItemDuration(item) ?? "\u2013"}</td>
                                    <td className="truncate-cell">{item.lastError ?? "\u2014"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {items.length === 0 ? (
                              <p className="empty-state">No items for this filter.</p>
                            ) : null}
                          </div>

                          <aside className="response-inspector">
                            <div className="inspector-header">
                              <strong>Inspector</strong>
                              {selectedItem ? (
                                <span
                                  className={`status-tag status-${selectedItem.status.toLowerCase()}`}
                                >
                                  #{selectedItem.sequence}
                                </span>
                              ) : null}
                            </div>
                            {selectedItem ? (() => {
                              const parsedResp = parseItemResponse(selectedItem.response);
                              const respHeaderEntries = Object.entries(parsedResp.headers);
                              const copyIcon = (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                              );
                              return (
                              <div className="inspector-sections">
                                <div className="inspector-meta">
                                  <span>{selectedItem.itemValue}</span>
                                  <span className={`status-tag status-${selectedItem.status.toLowerCase()}`}>{selectedItem.lastHttpStatus ?? "\u2013"}</span>
                                  {formatItemDuration(selectedItem) ? (
                                    <span className="inspector-duration">{formatItemDuration(selectedItem)}</span>
                                  ) : null}
                                  {parsedResp.size !== null ? (
                                    <span className="inspector-size">{formatBytes(parsedResp.size)}</span>
                                  ) : null}
                                  <span className="inspector-attempts">×{selectedItem.attemptCount}</span>
                                </div>
                                <div className="inspector-block">
                                  <div className="inspector-block-header">
                                    <span>Request</span>
                                    <button type="button" className="copy-col-btn" title="Copy request"
                                      onClick={() => { void navigator.clipboard.writeText(formatStructuredValue(selectedItem.request)); flashCopied("Request copied!"); }}>
                                      {copyIcon}
                                    </button>
                                  </div>
                                  <pre dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(selectedItem.request) }} />
                                </div>
                                <div className="inspector-block">
                                  <div className="inspector-block-header">
                                    <span>Response body</span>
                                    <button type="button" className="copy-col-btn" title="Copy response"
                                      onClick={() => { void navigator.clipboard.writeText(formatStructuredValue(parsedResp.body)); flashCopied("Response copied!"); }}>
                                      {copyIcon}
                                    </button>
                                  </div>
                                  <pre dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(parsedResp.body) }} />
                                </div>
                                {respHeaderEntries.length > 0 ? (
                                  <div className="inspector-block">
                                    <div className="inspector-block-header">
                                      <span>Response headers</span>
                                      <button type="button" className="copy-col-btn" title="Copy headers"
                                        onClick={() => { void navigator.clipboard.writeText(respHeaderEntries.map(([k, v]) => `${k}: ${v}`).join("\n")); flashCopied("Headers copied!"); }}>
                                        {copyIcon}
                                      </button>
                                    </div>
                                    <dl className="resp-headers-list">
                                      {respHeaderEntries.map(([k, v]) => (
                                        <div key={k} className="resp-header-row">
                                          <dt>{k}</dt>
                                          <dd>{v}</dd>
                                        </div>
                                      ))}
                                    </dl>
                                  </div>
                                ) : null}
                                {selectedItem.lastError ? (
                                  <div className="inspector-block inspector-block-error">
                                    <div className="inspector-block-header">
                                      <span>Error</span>
                                      <button type="button" className="copy-col-btn" title="Copy error"
                                        onClick={() => { void navigator.clipboard.writeText(selectedItem.lastError ?? ""); flashCopied("Error copied!"); }}>
                                        {copyIcon}
                                      </button>
                                    </div>
                                    <pre>{selectedItem.lastError}</pre>
                                  </div>
                                ) : null}
                              </div>
                              );
                            })() : null}
                            ) : (
                              <p className="empty-state">Select a row to inspect.</p>
                          </aside>
                        </div>
                      </div>
                    ) : responseTab === "events" ? (
                      <div className="event-list">
                        {events.map((ev) => (
                          <div className="event-row" key={ev.id}>
                            <div className="event-top">
                              <span className={`status-tag level-${ev.level}`}>{ev.level}</span>
                              <strong>{ev.eventType}</strong>
                              <small style={{ color: "var(--ink-dim)" }}>
                                {formatDate(ev.createdAt)}
                              </small>
                            </div>
                            <p>{ev.message}</p>
                          </div>
                        ))}
                        {events.length === 0 ? (
                          <p className="empty-state">No events recorded.</p>
                        ) : null}
                      </div>
                    ) : (
                      <dl className="config-list">
                        {Object.entries(runDetail.config).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{formatConfigValue(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* Run history when no run selected */}
                  {endpointRuns.length > 0 ? (
                    <div className="run-history run-history-primary">
                      <details open>
                        <summary className="events-summary">
                          <span>Run history</span>
                          <span className="events-count">{endpointRuns.length}</span>
                        </summary>
                        <div className="run-history-list">
                          {endpointRuns.map((run) => (
                            <button
                              className={`run-history-item ${selectedRunId === run.id ? "active" : ""}`}
                              key={run.id}
                              onClick={() => setSelectedRunId(run.id)}
                              type="button"
                            >
                              <div className="run-history-item-top">
                                <strong>{run.label ?? run.action}</strong>
                                <span
                                  className={`status-tag status-${run.status.toLowerCase()}`}
                                >
                                  {run.status.toLowerCase()}
                                </span>
                              </div>
                              <span className="run-history-item-meta">
                                {run.completedItems}/{run.totalItems} done &middot;{" "}
                                {run.failedItems} failed &middot; {formatDate(run.createdAt)}
                              </span>
                            </button>
                          ))}
                        </div>
                      </details>
                    </div>
                  ) : (
                    <div className="empty-workspace">
                      <div className="empty-workspace-icon">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                      </div>
                      <div>
                        <p className="empty-workspace-label">Ready to send</p>
                        <p>Configure parameters above and click <strong>Send</strong> to start a run.</p>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Run history below results when a run is selected */}
              {runDetail && endpointRuns.length > 0 ? (
                <div className="run-history">
                  <details>
                    <summary className="events-summary">
                      <span>Run history</span>
                      <span className="events-count">{endpointRuns.length}</span>
                    </summary>
                    <div className="run-history-list">
                      {endpointRuns.map((run) => (
                        <button
                          className={`run-history-item ${selectedRunId === run.id ? "active" : ""}`}
                          key={run.id}
                          onClick={() => setSelectedRunId(run.id)}
                          type="button"
                        >
                          <div className="run-history-item-top">
                            <strong>{run.label ?? run.action}</strong>
                            <span
                              className={`status-tag status-${run.status.toLowerCase()}`}
                            >
                              {run.status.toLowerCase()}
                            </span>
                          </div>
                          <span className="run-history-item-meta">
                            {run.completedItems}/{run.totalItems} done &middot;{" "}
                            {run.failedItems} failed &middot; {formatDate(run.createdAt)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </details>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <div className="empty-workspace">
            <div className="empty-workspace-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div>
              <p className="empty-workspace-label">Select an endpoint</p>
              <p>Choose an endpoint from the collection sidebar to configure and run requests.</p>
            </div>
          </div>
        )}
      </main>

      {/* ── Status bar (bottom) ───────────────────────────────────── */}
      <div className="status-bar">
        <div className="status-bar-left">
          <span className="status-bar-item">
            {selectedModule?.serviceName ?? "CLX Testing"}
          </span>
          {selectedEndpoint ? (
            <span className="status-bar-item">
              {selectedEndpoint.method} {selectedEndpoint.action}
            </span>
          ) : null}
        </div>
        <div className="status-bar-right">
          <span className="status-bar-item">
            {formState.targetEnvironment}
          </span>
          {runDetail ? (
            <span className="status-bar-item">
              {runDetail.status} &middot; {progressPercentage}%
            </span>
          ) : null}
          {shouldPoll ? (
            <span className="status-bar-item">
              &#9679; Live
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
