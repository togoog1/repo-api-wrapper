import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CreateRunFormState, ModuleCatalog, ModuleEndpointCatalog, NavFolderNode,
  QueryParamRow, RunDetail, RunEvent, RunItem, RunItemStatus,
  RunSummary, RuntimeConfig, SavedInputList, Tab, TargetEnvironment,
} from "./types";
import { defaultFormState } from "./types";
import {
  applyEnvVars, applyCatalogDefaults, buildFolderTree, buildPreviewUrl,
  countTreeEndpoints, extractAllPathTokens, formatBytes,
  formatConfigValue, formatDate, formatInputListData, formatRuntime,
  formatStructuredValue, getSelectedEndpoint, getSelectedModule,
  highlightSearch, parseIdList, parseItemResponse, requestJson,
  syntaxHighlightJson, usePolling,
} from "./helpers";
import { KeyValueTable } from "./components/KeyValueTable";
import { Modal } from "./components/Modal";
import { RunHistoryItem } from "./components/RunHistoryItem";
import { VarInput, VarTextarea } from "./components/VarHighlight";
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
  const [inspectorSearch, setInspectorSearch] = useState("");
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
  const [moduleMenu, setModuleMenu] = useState<{ slug: string; x: number; y: number } | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{ moduleSlug: string; folderPath: string[]; x: number; y: number } | null>(null);
  const [selectedEndpoints, setSelectedEndpoints] = useState<Set<string>>(new Set());
  const lastClickedEndpointRef = useRef<string | null>(null);
  const [multiSelectMenu, setMultiSelectMenu] = useState<{ x: number; y: number } | null>(null);
  const [addFolderDialog, setAddFolderDialog] = useState<{ moduleSlug: string; parentFolderPath: string[] } | null>(null);
  const [addRequestDialog, setAddRequestDialog] = useState<{ moduleSlug: string; folderPath: string[] } | null>(null);
  const [addFolderName, setAddFolderName] = useState("");
  const [addRequestName, setAddRequestName] = useState("");
  const [addRequestMethod, setAddRequestMethod] = useState("GET");
  const [addRequestPath, setAddRequestPath] = useState("");
  const [moduleConfigDrafts, setModuleConfigDrafts] = useState<Record<string, {
    module: ModuleCatalog;
    overrides: Record<string, unknown>;
    draft: Record<string, unknown>;
    activeSection: string;
  }>>({});
  const [moduleConfigSaving, setModuleConfigSaving] = useState(false);
  const [bakeConfirmSlug, setBakeConfirmSlug] = useState<string | null>(null);
  const [baking, setBaking] = useState(false);
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
        result.set(mod.slug, buildFolderTree(mod.slug, filtered, mod.customFolders));
      }
    }
    return result;
  }, [modules, navSearch]);

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
  const moduleVarsForPreview: QueryParamRow[] = useMemo(() =>
    selectedModule?.variables
      ? Object.entries(selectedModule.variables).map(([key, value]) => ({ key, value }))
      : [],
    [selectedModule],
  );

  /** Set of all variable names that will resolve at runtime — drives VarInput/VarTextarea highlighting */
  const availableVarNames = useMemo(() => {
    const names = new Set<string>();
    if (selectedModule?.variables) {
      for (const key of Object.keys(selectedModule.variables)) names.add(key);
    }
    for (const v of envVars) {
      if (v.key.trim()) names.add(v.key.trim());
    }
    names.add("itemValue");
    for (const token of pathTokens) names.add(token);
    return names;
  }, [selectedModule, envVars, pathTokens]);

  const previewUrl = buildPreviewUrl({
    baseUrl: selectedModule?.environments[formState.targetEnvironment]?.baseUrl,
    pathTemplate: formState.pathTemplate,
    idsRaw: formState.idsRaw,
    tokenValues: formState.tokenValues,
    queryParams: formState.queryParams,
    envVars: [...moduleVarsForPreview, ...envVars],
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

  // (Folders start collapsed — user expands them manually)

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
      type: "endpoint",
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
    // If closing a module-config tab, clean up its draft state
    const closingTab = tabs.find((t) => t.id === tabId);
    if (closingTab?.type === "module-config") {
      setModuleConfigDrafts((prev) => {
        const next = { ...prev };
        delete next[closingTab.moduleSlug];
        return next;
      });
    }
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        // Activate the nearest remaining tab, or clear
        const closedIndex = prev.findIndex((t) => t.id === tabId);
        const fallback = next[Math.min(closedIndex, next.length - 1)] ?? null;
        if (fallback) {
          setTimeout(() => {
            setActiveTabId(fallback.id);
            if (fallback.type === "endpoint" && selectedModule) {
              const ep = selectedModule.endpoints.find((e) => e.slug === fallback.endpointSlug);
              if (ep) activateEndpoint(ep);
            }
          }, 0);
        } else {
          setTimeout(() => {
            setActiveTabId(null);
            clearRunState();
            setFormState((cur) => ({ ...cur, endpointSlug: "", moduleSlug: "" }));
          }, 0);
        }
      }
      return next;
    });
  }

  function handleClickTab(tab: Tab) {
    if (activeTabId === tab.id) return;
    setActiveTabId(tab.id);
    if (tab.type === "module-config") return;
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
      // Module-level variables are lower priority; sidebar env vars override them
      const moduleVars: QueryParamRow[] = selectedModule?.variables
        ? Object.entries(selectedModule.variables).map(([key, value]) => ({ key, value }))
        : [];
      const ev = [...moduleVars, ...envVars.filter((v) => v.key.trim())];
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
      const headers = hEntries.length > 0
        ? Object.fromEntries(hEntries.map((p) => [p.key.trim(), sub(p.value)]))
        : undefined;

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
        skipAuth: formState.skipAuth,
        disabledDefaultHeaders: formState.disabledDefaultHeaders.length > 0
          ? formState.disabledDefaultHeaders
          : undefined,
        timeoutMs: formState.timeoutMs
          ? Number.parseInt(formState.timeoutMs, 10)
          : undefined,
        followRedirects: formState.followRedirects,
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

  function handleReplayRun() {
    if (!runDetail) return;
    const cfg = runDetail.config;
    const safeStr = (v: unknown) => typeof v === "string" ? v : "";
    const safeNum = (v: unknown, fallback: number) => typeof v === "number" ? v : fallback;

    const cfgHeaders = cfg.headers && typeof cfg.headers === "object" && !Array.isArray(cfg.headers)
      ? cfg.headers as Record<string, string> : {};
    const headerRows: QueryParamRow[] = Object.entries(cfgHeaders).length > 0
      ? [...Object.entries(cfgHeaders).map(([key, value]) => ({ key, value })), { key: "", value: "" }]
      : [{ key: "", value: "" }];

    const cfgQp = cfg.queryParams && typeof cfg.queryParams === "object" && !Array.isArray(cfg.queryParams)
      ? cfg.queryParams as Record<string, string> : {};
    const qpRows: QueryParamRow[] = Object.entries(cfgQp).length > 0
      ? [...Object.entries(cfgQp).map(([key, value]) => ({ key, value })), { key: "", value: "" }]
      : [{ key: "", value: "" }];

    const cfgFormBody = cfg.formBody && typeof cfg.formBody === "object" && !Array.isArray(cfg.formBody)
      ? cfg.formBody as Record<string, string> : {};
    const formRows: QueryParamRow[] = Object.entries(cfgFormBody).length > 0
      ? [...Object.entries(cfgFormBody).map(([key, value]) => ({ key, value })), { key: "", value: "" }]
      : [{ key: "", value: "" }];

    const ids = Array.isArray(cfg.itemValues) ? (cfg.itemValues as string[]).filter((v) => v !== "0") : [];
    const stopCodes = Array.isArray(cfg.stopOnHttpStatuses) ? (cfg.stopOnHttpStatuses as number[]).join(",") : "";

    const replayModuleSlug = safeStr(runDetail.moduleSlug);
    const replayEndpointSlug = safeStr(cfg.endpointSlug);

    setFormState((cur) => ({
      ...cur,
      moduleSlug: replayModuleSlug,
      endpointSlug: replayEndpointSlug,
      targetEnvironment: (safeStr(cfg.targetEnvironment) || cur.targetEnvironment) as TargetEnvironment,
      method: safeStr(cfg.method) || cur.method,
      pathTemplate: safeStr(cfg.pathTemplate) || cur.pathTemplate,
      bodyType: (["none","json","form","multipart","text"].includes(safeStr(cfg.bodyType)) ? safeStr(cfg.bodyType) : cur.bodyType) as "none" | "json" | "form" | "multipart" | "text",
      requestBodyRaw: cfg.requestBody && typeof cfg.requestBody === "object" ? JSON.stringify(cfg.requestBody, null, 2) : safeStr(cfg.requestBodyText),
      idsRaw: ids.join("\n"),
      label: "",
      queryParams: qpRows,
      headers: headerRows,
      formBodyRows: formRows,
      dryRun: typeof cfg.dryRun === "boolean" ? cfg.dryRun : cur.dryRun,
      concurrency: safeNum(cfg.concurrency, cur.concurrency),
      minDelayMs: safeNum(cfg.minDelayMs, cur.minDelayMs),
      maxRequestsPerMinute: typeof cfg.maxRequestsPerMinute === "number" ? String(cfg.maxRequestsPerMinute) : "",
      maxRetries: safeNum(cfg.maxRetries, cur.maxRetries),
      retryDelayMs: safeNum(cfg.retryDelayMs, cur.retryDelayMs),
      stopAfterFailures: typeof cfg.stopAfterFailures === "number" ? String(cfg.stopAfterFailures) : "",
      stopAfterConsecutiveFailures: typeof cfg.stopAfterConsecutiveFailures === "number" ? String(cfg.stopAfterConsecutiveFailures) : "",
      stopOnHttpStatuses: stopCodes,
      skipAuth: typeof cfg.skipAuth === "boolean" ? cfg.skipAuth : false,
      disabledDefaultHeaders: [],
      timeoutMs: typeof cfg.timeoutMs === "number" ? String(cfg.timeoutMs) : "",
      followRedirects: typeof cfg.followRedirects === "boolean" ? cfg.followRedirects : true,
    }));

    // Sync tab bar so the replayed endpoint is visible & active
    if (replayModuleSlug && replayEndpointSlug) {
      const tabId = `${replayModuleSlug}:${replayEndpointSlug}`;
      const replayMod = modules.find((m) => m.slug === replayModuleSlug);
      const replayEp = replayMod?.endpoints.find((e) => e.slug === replayEndpointSlug);
      if (replayEp) {
        const existing = tabs.find((t) => t.id === tabId);
        if (!existing) {
          setTabs((prev) => {
            const pinned = prev.filter((t) => t.pinned);
            return [...pinned, {
              id: tabId,
              endpointSlug: replayEndpointSlug,
              moduleSlug: replayModuleSlug,
              method: replayEp.method,
              label: replayEp.label,
              pinned: false,
            }];
          });
        }
        setActiveTabId(tabId);
      }
    }

    setSuccessMessage("Restored form from previous run config.");
    setTimeout(() => setSuccessMessage(null), 3000);
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

  /** Flatten tree into an ordered list of endpoint slugs for shift-click range selection. */
  function flattenTree(node: NavFolderNode): string[] {
    const result: string[] = [];
    for (const child of node.children) result.push(...flattenTree(child));
    for (const ep of node.endpoints) result.push(ep.slug);
    return result;
  }

  function handleEndpointClick(ep: ModuleEndpointCatalog, mod: ModuleCatalog, e: React.MouseEvent) {
    if (e.shiftKey && lastClickedEndpointRef.current && mod.slug === formState.moduleSlug) {
      // Shift-click: range select
      const tree = navTreeByModule.get(mod.slug);
      if (tree) {
        const flat = flattenTree(tree);
        const anchorIdx = flat.indexOf(lastClickedEndpointRef.current);
        const targetIdx = flat.indexOf(ep.slug);
        if (anchorIdx !== -1 && targetIdx !== -1) {
          const start = Math.min(anchorIdx, targetIdx);
          const end = Math.max(anchorIdx, targetIdx);
          const range = new Set(flat.slice(start, end + 1));
          setSelectedEndpoints(range);
          return;
        }
      }
    }
    // Normal click: clear multi-select, select endpoint
    setSelectedEndpoints(new Set());
    lastClickedEndpointRef.current = ep.slug;
    handleSelectEndpoint(ep, mod);
  }

  function handleEndpointContextMenu(ep: ModuleEndpointCatalog, mod: ModuleCatalog, e: React.MouseEvent) {
    e.preventDefault();
    if (selectedEndpoints.size > 1 && selectedEndpoints.has(ep.slug)) {
      // Right-click on multi-selection: show multi-select menu
      setMultiSelectMenu({ x: e.clientX, y: e.clientY });
    } else {
      setSelectedEndpoints(new Set());
      setContextMenuEndpoint({ slug: ep.slug, x: e.clientX, y: e.clientY });
    }
  }

  async function handleAddFolder() {
    if (!addFolderDialog || !addFolderName.trim()) return;
    try {
      const folderPath = [...addFolderDialog.parentFolderPath, addFolderName.trim()];
      await requestJson(`/api/modules/${addFolderDialog.moduleSlug}/folders`, {
        method: "POST",
        body: JSON.stringify({ folderPath }),
      });
      const cfg = await requestJson<RuntimeConfig>("/api/config");
      setRuntimeConfig(cfg);
      // Auto-open the new folder
      setOpenFolders((prev) => {
        const next = new Set(prev);
        next.add(`${addFolderDialog.moduleSlug}/${folderPath.join("/")}`);
        return next;
      });
      setAddFolderDialog(null);
      setAddFolderName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder");
    }
  }

  async function handleAddRequest() {
    if (!addRequestDialog || !addRequestName.trim() || !addRequestPath.trim()) return;
    try {
      const folder = addRequestDialog.folderPath.length > 0 ? addRequestDialog.folderPath : undefined;
      await requestJson(`/api/modules/${addRequestDialog.moduleSlug}/endpoints`, {
        method: "POST",
        body: JSON.stringify({
          label: addRequestName.trim(),
          method: addRequestMethod,
          pathTemplate: addRequestPath.trim(),
          folder,
        }),
      });
      const cfg = await requestJson<RuntimeConfig>("/api/config");
      setRuntimeConfig(cfg);
      setAddRequestDialog(null);
      setAddRequestName("");
      setAddRequestMethod("GET");
      setAddRequestPath("");
      setSuccessMessage("Request added.");
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create request");
    }
  }

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenuEndpoint) return;
    const handler = () => setContextMenuEndpoint(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [contextMenuEndpoint]);

  // Close module menu on outside click (deferred so the opening click doesn't race)
  useEffect(() => {
    if (!moduleMenu) return;
    let cleanup = () => { /* noop */ };
    const raf = requestAnimationFrame(() => {
      const handler = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest?.(".module-context-menu")) return;
        setModuleMenu(null);
      };
      window.addEventListener("click", handler);
      cleanup = () => window.removeEventListener("click", handler);
    });
    return () => {
      cancelAnimationFrame(raf);
      cleanup();
    };
  }, [moduleMenu]);

  // Close folder context menu on outside click
  useEffect(() => {
    if (!folderContextMenu) return;
    const handler = () => setFolderContextMenu(null);
    requestAnimationFrame(() => {
      window.addEventListener("click", handler);
    });
    return () => window.removeEventListener("click", handler);
  }, [folderContextMenu]);

  // Close multi-select menu on outside click
  useEffect(() => {
    if (!multiSelectMenu) return;
    const handler = () => setMultiSelectMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [multiSelectMenu]);

  async function openModuleConfigEditor(slug: string) {
    setModuleMenu(null);

    // If a config tab for this module is already open, just activate it
    const existing = tabs.find((t) => t.type === "module-config" && t.moduleSlug === slug);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    try {
      const data = await requestJson<{
        module: ModuleCatalog;
        overrides: Record<string, unknown>;
        hasOverrides: boolean;
      }>(`/api/modules/${slug}/config`);

      setModuleConfigDrafts((prev) => ({
        ...prev,
        [slug]: {
          module: data.module,
          overrides: data.overrides,
          draft: { ...data.overrides },
          activeSection: "general",
        },
      }));

      const tabId = `config:${slug}`;
      const mod = modules.find((m) => m.slug === slug);
      const newTab: Tab = {
        id: tabId,
        type: "module-config",
        moduleSlug: slug,
        label: mod?.label ?? slug,
        pinned: true,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load module config");
    }
  }

  async function saveModuleConfig(slug: string) {
    const configDraft = moduleConfigDrafts[slug];
    if (!configDraft) return;
    setModuleConfigSaving(true);
    try {
      await requestJson(`/api/modules/${slug}/config`, {
        method: "PATCH",
        body: JSON.stringify(configDraft.draft),
      });
      // reload runtime config to refresh sidebar
      const cfg = await requestJson<RuntimeConfig>("/api/config");
      setRuntimeConfig(cfg);
      setSuccessMessage("Module config saved.");
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save module config");
    } finally {
      setModuleConfigSaving(false);
    }
  }

  async function handleBakeModule(slug: string) {
    setBaking(true);
    try {
      await requestJson(`/api/modules/${slug}/bake`, { method: "POST", body: "{}" });
      const cfg = await requestJson<RuntimeConfig>("/api/config");
      setRuntimeConfig(cfg);
      setBakeConfirmSlug(null);
      // Refresh the config tab draft if open (overrides are now empty)
      if (moduleConfigDrafts[slug]) {
        try {
          const data = await requestJson<{ module: ModuleCatalog; overrides: Record<string, unknown>; hasOverrides: boolean }>(`/api/modules/${slug}/config`);
          setModuleConfigDrafts((prev) => ({
            ...prev,
            [slug]: { ...prev[slug], module: data.module, overrides: data.overrides, draft: { ...data.overrides } },
          }));
        } catch { /* ignore refresh failure */ }
      }
      setSuccessMessage("Overrides baked into .ts file. Backup created.");
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rewrite module file");
    } finally {
      setBaking(false);
    }
  }

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
                const activeTab = tabs.find((t) => t.id === activeTabId);
                const isSelected = formState.moduleSlug === mod.slug || (activeTab?.type === "module-config" && activeTab.moduleSlug === mod.slug);

                function renderFolderNode(node: NavFolderNode, depth: number): React.ReactNode {
                  const isOpen = openFolders.has(node.key);
                  const totalCount = countTreeEndpoints(node);
                  // Derive folder path from node.key: "modSlug/a/b" → ["a","b"]
                  const folderPath = node.key.split("/").slice(1);
                  return (
                    <div className="tree-folder" key={node.key} style={{ "--folder-depth": depth } as React.CSSProperties}>
                      <button
                        className="tree-folder-header"
                        onClick={() => toggleFolder(node.key)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setFolderContextMenu({ moduleSlug: mod.slug, folderPath, x: e.clientX, y: e.clientY });
                        }}
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
                              className={`tree-item ${selectedEndpoints.has(ep.slug) ? "multi-selected" : ""} ${activeTab?.type !== "module-config" && formState.moduleSlug === mod.slug && formState.endpointSlug === ep.slug ? "active" : ""}`}
                              key={ep.slug}
                              onClick={(e) => handleEndpointClick(ep, mod, e)}
                              onContextMenu={(e) => handleEndpointContextMenu(ep, mod, e)}
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
                    <div className={`tree-collection-header ${isSelected ? "active" : ""}`}>
                      <button
                        className="tree-collection-toggle"
                        onClick={() =>
                          setOpenModules((prev) => {
                            const next = new Set(prev);
                            if (next.has(mod.slug)) next.delete(mod.slug);
                            else next.add(mod.slug);
                            return next;
                          })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setFolderContextMenu({ moduleSlug: mod.slug, folderPath: [], x: e.clientX, y: e.clientY });
                        }}
                        type="button"
                      >
                        <span className={`tree-chevron ${modOpen ? "open" : ""}`}>&#9654;</span>
                        <span className="tree-folder-icon">&#128193;</span>
                        <span>{mod.label}</span>
                        <span className="tree-folder-count">{mod.endpoints.length}</span>
                      </button>
                      <span className={`tree-collection-actions${moduleMenu?.slug === mod.slug ? " menu-open" : ""}`}>
                        <span
                          className="tree-item-action module-menu-trigger"
                          title="Module actions"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (moduleMenu?.slug === mod.slug) {
                              setModuleMenu(null);
                            } else {
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setModuleMenu({ slug: mod.slug, x: rect.right, y: rect.bottom + 2 });
                            }
                          }}
                        >&hellip;</span>
                      </span>
                    </div>

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
                    <RunHistoryItem key={run.id} run={run} isActive={selectedRunId === run.id} onClick={() => handleSelectRunFromHistory(run)} />
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
                <KeyValueTable rows={envVars} onChange={setEnvVars} keyPlaceholder="Variable name" />
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

      {/* ── Module context menu (fixed, rendered outside tree) ───── */}
      {moduleMenu ? (() => {
        const mod = modules.find((m) => m.slug === moduleMenu.slug);
        if (!mod) return null;
        return (
          <div className="context-menu module-context-menu" style={{ top: moduleMenu.y, left: moduleMenu.x }}>
            <button type="button" onClick={() => { setAddRequestDialog({ moduleSlug: mod.slug, folderPath: [] }); setModuleMenu(null); }}>Add request</button>
            <button type="button" onClick={() => { setAddFolderDialog({ moduleSlug: mod.slug, parentFolderPath: [] }); setModuleMenu(null); }}>Add folder</button>
            <div className="context-menu-divider" />
            <button type="button" onClick={() => void openModuleConfigEditor(mod.slug)}>Edit Config</button>
            <button type="button" onClick={() => { exportAsPostman(mod); setModuleMenu(null); }}>Export as Postman</button>
            <button type="button" onClick={() => { setBakeConfirmSlug(mod.slug); setModuleMenu(null); }}>Rewrite Module File</button>
          </div>
        );
      })() : null}

      {/* ── Folder context menu ───────────────────────────────────── */}
      {folderContextMenu ? (
        <div className="context-menu" style={{ top: folderContextMenu.y, left: folderContextMenu.x }}>
          <button type="button" onClick={() => {
            setAddRequestDialog({ moduleSlug: folderContextMenu.moduleSlug, folderPath: folderContextMenu.folderPath });
            setFolderContextMenu(null);
          }}>Add request</button>
          <button type="button" onClick={() => {
            setAddFolderDialog({ moduleSlug: folderContextMenu.moduleSlug, parentFolderPath: folderContextMenu.folderPath });
            setFolderContextMenu(null);
          }}>Add folder</button>
        </div>
      ) : null}

      {/* ── Multi-select context menu ─────────────────────────────── */}
      {multiSelectMenu && selectedEndpoints.size > 0 ? (
        <div className="context-menu" style={{ top: multiSelectMenu.y, left: multiSelectMenu.x }}>
          <button type="button" onClick={() => {
            const eps = (selectedModule?.endpoints ?? []).filter((e) => selectedEndpoints.has(e.slug));
            for (const ep of eps) handleOpenInNewTab(ep);
            setMultiSelectMenu(null);
            setSelectedEndpoints(new Set());
          }}>Open {selectedEndpoints.size} in tabs</button>
          <button type="button" onClick={() => {
            const eps = (selectedModule?.endpoints ?? []).filter((e) => selectedEndpoints.has(e.slug));
            const text = eps.map((e) => `${e.method} ${e.pathTemplate}`).join("\n");
            void navigator.clipboard.writeText(text);
            setSuccessMessage(`Copied ${eps.length} paths.`);
            setTimeout(() => setSuccessMessage(null), 3000);
            setMultiSelectMenu(null);
            setSelectedEndpoints(new Set());
          }}>Copy {selectedEndpoints.size} paths</button>
        </div>
      ) : null}

      {/* ── Add Folder Dialog ─────────────────────────────────────── */}
      {addFolderDialog ? (
        <Modal title="Add Folder" onClose={() => { setAddFolderDialog(null); setAddFolderName(""); }} footer={<>
          <button type="button" className="ghost-button" onClick={() => { setAddFolderDialog(null); setAddFolderName(""); }}>Cancel</button>
          <button type="button" className="primary-button" disabled={!addFolderName.trim()} onClick={() => void handleAddFolder()}>Create</button>
        </>}>
          {addFolderDialog.parentFolderPath.length > 0 ? (
            <p className="config-hint">Inside: {addFolderDialog.parentFolderPath.join(" / ")}</p>
          ) : null}
          <label className="entity-field">
            <span className="entity-field-label">Folder name</span>
            <input
              value={addFolderName}
              onChange={(e) => setAddFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleAddFolder(); }}
              autoFocus
              placeholder="e.g. Accounts"
            />
          </label>
        </Modal>
      ) : null}

      {/* ── Add Request Dialog ────────────────────────────────────── */}
      {addRequestDialog ? (
        <Modal title="Add Request" onClose={() => { setAddRequestDialog(null); setAddRequestName(""); setAddRequestPath(""); }} footer={<>
          <button type="button" className="ghost-button" onClick={() => { setAddRequestDialog(null); setAddRequestName(""); setAddRequestPath(""); }}>Cancel</button>
          <button type="button" className="primary-button" disabled={!addRequestName.trim() || !addRequestPath.trim()} onClick={() => void handleAddRequest()}>Create</button>
        </>}>
          {addRequestDialog.folderPath.length > 0 ? (
            <p className="config-hint">Inside: {addRequestDialog.folderPath.join(" / ")}</p>
          ) : null}
          <label className="entity-field" style={{ marginBottom: 12 }}>
            <span className="entity-field-label">Name</span>
            <input
              value={addRequestName}
              onChange={(e) => setAddRequestName(e.target.value)}
              autoFocus
              placeholder="e.g. Get User"
            />
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            <label className="entity-field" style={{ flex: "0 0 100px" }}>
              <span className="entity-field-label">Method</span>
              <select value={addRequestMethod} onChange={(e) => setAddRequestMethod(e.target.value)}>
                <option>GET</option>
                <option>POST</option>
                <option>PUT</option>
                <option>PATCH</option>
                <option>DELETE</option>
              </select>
            </label>
            <label className="entity-field" style={{ flex: 1 }}>
              <span className="entity-field-label">Path</span>
              <input
                value={addRequestPath}
                onChange={(e) => setAddRequestPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleAddRequest(); }}
                placeholder="/example/:id"
              />
            </label>
          </div>
        </Modal>
      ) : null}

      {/* ── Bake Confirmation Dialog ──────────────────────────────── */}
      {bakeConfirmSlug ? (
        <Modal title="Rewrite Module File" onClose={() => setBakeConfirmSlug(null)} footer={<>
          <button type="button" className="ghost-button" onClick={() => setBakeConfirmSlug(null)}>Cancel</button>
          <button type="button" className="danger-button" disabled={baking} onClick={() => void handleBakeModule(bakeConfirmSlug)}>
            {baking ? "Rewriting\u2026" : "Rewrite .ts File"}
          </button>
        </>}>
          <p>This will regenerate the <code>.ts</code> module file for <strong>{bakeConfirmSlug}</strong> from the current merged config (base + overrides).</p>
          <p className="config-hint">A <code>.bak</code> backup of the original file will be created first. The override file will be deleted after baking.</p>
          <p className="config-hint" style={{ color: "var(--warning)" }}>This replaces comments and custom formatting in the .ts file. Only do this when you want to commit the overrides permanently.</p>
        </Modal>
      ) : null}

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
              {tab.type === "module-config" ? (
                <span className="tab-strip-icon">&#9881;</span>
              ) : (
                <span className={`tab-strip-method ${(tab.method ?? "GET").toLowerCase()}`}>
                  {tab.method}
                </span>
              )}
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

        {/* ── Module Config Entity Editor (tab panel) ─────────────── */}
        {(() => {
          const aTab = tabs.find((t) => t.id === activeTabId);
          if (!aTab || aTab.type !== "module-config") return null;
          const cfgSlug = aTab.moduleSlug;
          const cfgState = moduleConfigDrafts[cfgSlug];
          if (!cfgState) return null;
          const { module: mod, draft, activeSection } = cfgState;

          const getField = <T,>(path: string, fallback: T): T => {
            const parts = path.split(".");
            let cursor: unknown = draft;
            for (const p of parts) {
              if (cursor && typeof cursor === "object" && p in (cursor as Record<string, unknown>)) {
                cursor = (cursor as Record<string, unknown>)[p];
              } else { cursor = undefined; break; }
            }
            if (cursor !== undefined) return cursor as T;
            let baseCursor: unknown = mod;
            for (const p of parts) {
              if (baseCursor && typeof baseCursor === "object" && p in (baseCursor as Record<string, unknown>)) {
                baseCursor = (baseCursor as Record<string, unknown>)[p];
              } else return fallback;
            }
            return (baseCursor ?? fallback) as T;
          };

          const setField = (path: string, value: unknown) => {
            const parts = path.split(".");
            setModuleConfigDrafts((prev) => {
              const entry = prev[cfgSlug];
              if (!entry) return prev;
              const newDraft = JSON.parse(JSON.stringify(entry.draft)) as Record<string, unknown>;
              let cursor = newDraft;
              for (let i = 0; i < parts.length - 1; i++) {
                if (!(parts[i] in cursor) || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {};
                cursor = cursor[parts[i]] as Record<string, unknown>;
              }
              cursor[parts[parts.length - 1]] = value;
              return { ...prev, [cfgSlug]: { ...entry, draft: newDraft } };
            });
          };

          const setSection = (s: string) => {
            setModuleConfigDrafts((prev) => {
              const entry = prev[cfgSlug];
              if (!entry) return prev;
              return { ...prev, [cfgSlug]: { ...entry, activeSection: s } };
            });
          };

          const authMode = getField<string>("auth.mode", mod.auth?.mode ?? "jwt");

          const sections = [
            { key: "general", label: "General", icon: "\u2699" },
            { key: "environments", label: "Environments", icon: "\uD83C\uDF10" },
            { key: "auth", label: "Authorization", icon: "\uD83D\uDD12" },
            { key: "headers", label: "Headers", icon: "\u2630" },
            { key: "variables", label: "Variables", icon: "{ }" },
          ];

          return (
            <div className="entity-editor">
              {/* Entity header */}
              <div className="entity-header">
                <div className="entity-title-row">
                  <span className="entity-icon">{"\uD83D\uDCC1"}</span>
                  <div className="entity-title-group">
                    <h2 className="entity-title">{getField("label", mod.label)}</h2>
                    <span className="entity-subtitle">{getField("serviceName", mod.serviceName)} &middot; {mod.endpoints.length} endpoints</span>
                  </div>
                  <div className="entity-actions">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={moduleConfigSaving}
                      onClick={() => void saveModuleConfig(cfgSlug)}
                    >{moduleConfigSaving ? "Saving\u2026" : "Save"}</button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => { setBakeConfirmSlug(cfgSlug); }}
                    >Bake to .ts</button>
                  </div>
                </div>
                {/* Section tabs */}
                <div className="entity-section-tabs">
                  {sections.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      className={`entity-section-tab ${activeSection === s.key ? "active" : ""}`}
                      onClick={() => setSection(s.key)}
                    >{s.label}</button>
                  ))}
                </div>
              </div>

              {/* Section content */}
              <div className="entity-body">
                {activeSection === "general" ? (
                  <div className="entity-section">
                    <div className="entity-card">
                      <h3 className="entity-card-title">Identity</h3>
                      <div className="entity-field-grid">
                        <label className="entity-field">
                          <span className="entity-field-label">Label</span>
                          <input value={getField("label", mod.label)} onChange={(e) => setField("label", e.target.value)} />
                        </label>
                        <label className="entity-field">
                          <span className="entity-field-label">Service Name</span>
                          <input value={getField("serviceName", mod.serviceName)} onChange={(e) => setField("serviceName", e.target.value)} />
                        </label>
                      </div>
                      <label className="entity-field">
                        <span className="entity-field-label">Description</span>
                        <textarea rows={3} value={getField("description", mod.description ?? "")} onChange={(e) => setField("description", e.target.value)} />
                      </label>
                    </div>
                    <div className="entity-card">
                      <h3 className="entity-card-title">Defaults</h3>
                      <label className="entity-field" style={{ maxWidth: 260 }}>
                        <span className="entity-field-label">Default Environment</span>
                        <select value={getField("defaultTargetEnvironment", mod.defaultTargetEnvironment)} onChange={(e) => setField("defaultTargetEnvironment", e.target.value)}>
                          {(() => {
                            const envs = getField<Record<string, { baseUrl: string }>>("environments", mod.environments ?? {});
                            const keys = Object.keys(envs);
                            if (keys.length === 0) keys.push("staging", "prod");
                            return keys.map((k) => <option key={k} value={k}>{k}</option>);
                          })()}
                        </select>
                      </label>
                    </div>
                  </div>
                ) : activeSection === "environments" ? (
                  <div className="entity-section">
                    <div className="entity-card">
                      <h3 className="entity-card-title">Environments</h3>
                      <p className="entity-hint">Base URLs per target environment. These are used to resolve request paths.</p>
                      <div className="entity-table">
                        <div className="entity-table-header">
                          <span className="entity-table-cell env-name-col">Name</span>
                          <span className="entity-table-cell env-url-col">Base URL</span>
                          <span className="entity-table-cell entity-table-action-col"></span>
                        </div>
                        {(() => {
                          const envs = getField<Record<string, { baseUrl: string }>>("environments", mod.environments ?? {});
                          return Object.entries(envs).map(([envKey, envVal]) => (
                            <div key={envKey} className="entity-table-row">
                              <span className="entity-table-cell env-name-col">
                                <input
                                  value={envKey}
                                  onChange={(e) => {
                                    const newEnvs = { ...envs };
                                    delete newEnvs[envKey];
                                    newEnvs[e.target.value] = envVal;
                                    setField("environments", newEnvs);
                                  }}
                                  placeholder="environment"
                                />
                              </span>
                              <span className="entity-table-cell env-url-col">
                                <input
                                  value={envVal?.baseUrl ?? ""}
                                  onChange={(e) => setField(`environments.${envKey}.baseUrl`, e.target.value)}
                                  placeholder="https://service.example.com"
                                />
                              </span>
                              <span className="entity-table-cell entity-table-action-col">
                                <button type="button" className="remove-row-btn" onClick={() => {
                                  const newEnvs = { ...envs };
                                  delete newEnvs[envKey];
                                  setField("environments", newEnvs);
                                }} title="Remove">&times;</button>
                              </span>
                            </div>
                          ));
                        })()}
                      </div>
                      <button type="button" className="ghost-button" style={{ marginTop: 8 }} onClick={() => {
                        const envs = getField<Record<string, { baseUrl: string }>>("environments", mod.environments ?? {});
                        setField("environments", { ...envs, "": { baseUrl: "" } });
                      }}>+ Add environment</button>
                    </div>
                  </div>
                ) : activeSection === "auth" ? (
                  <div className="entity-section">
                    <div className="entity-card">
                      <h3 className="entity-card-title">Authorization</h3>
                      <label className="entity-field" style={{ maxWidth: 260 }}>
                        <span className="entity-field-label">Auth Mode</span>
                        <select value={authMode} onChange={(e) => setField("auth.mode", e.target.value)}>
                          <option value="jwt">JWT</option>
                          <option value="apikey">API Key</option>
                          <option value="bearer">Bearer Token</option>
                          <option value="none">None</option>
                        </select>
                      </label>
                    </div>
                    {authMode === "jwt" ? (
                      <div className="entity-card">
                        <h3 className="entity-card-title">JWT Configuration</h3>
                        <div className="entity-field-grid">
                          <label className="entity-field">
                            <span className="entity-field-label">Secret Env Var</span>
                            <input value={getField("auth.secretEnvVar", mod.auth?.secretEnvVar ?? "")} onChange={(e) => setField("auth.secretEnvVar", e.target.value)} placeholder="MY_SERVICE_JWT_SECRET" />
                          </label>
                          <label className="entity-field">
                            <span className="entity-field-label">Email</span>
                            <input value={getField("auth.jwt.email", mod.auth?.jwt?.email ?? "")} onChange={(e) => setField("auth.jwt.email", e.target.value)} />
                          </label>
                          <label className="entity-field">
                            <span className="entity-field-label">Subject</span>
                            <input value={getField("auth.jwt.subject", "") as string} onChange={(e) => setField("auth.jwt.subject", e.target.value || undefined)} placeholder="(optional)" />
                          </label>
                          <label className="entity-field">
                            <span className="entity-field-label">Issuer</span>
                            <input value={getField("auth.jwt.issuer", "") as string} onChange={(e) => setField("auth.jwt.issuer", e.target.value || undefined)} placeholder="(optional)" />
                          </label>
                          <label className="entity-field">
                            <span className="entity-field-label">Audience</span>
                            <input value={getField("auth.jwt.audience", "") as string} onChange={(e) => setField("auth.jwt.audience", e.target.value || undefined)} placeholder="(optional)" />
                          </label>
                        </div>
                        <label className="entity-field" style={{ maxWidth: 200 }}>
                          <span className="entity-field-label">Expires In (seconds)</span>
                          <input type="number" value={getField("auth.jwt.expiresInSeconds", 300)} onChange={(e) => setField("auth.jwt.expiresInSeconds", Number(e.target.value))} />
                        </label>
                      </div>
                    ) : authMode === "apikey" ? (
                      <div className="entity-card">
                        <h3 className="entity-card-title">API Key Configuration</h3>
                        <div className="entity-field-grid">
                          <label className="entity-field">
                            <span className="entity-field-label">Header Name</span>
                            <input value={getField("auth.apikey.headerName", mod.auth?.apikey?.headerName ?? "")} onChange={(e) => setField("auth.apikey.headerName", e.target.value)} placeholder="x-api-key" />
                          </label>
                          <label className="entity-field">
                            <span className="entity-field-label">Value Env Var</span>
                            <input value={getField("auth.apikey.valueEnvVar", mod.auth?.apikey?.valueEnvVar ?? "")} onChange={(e) => setField("auth.apikey.valueEnvVar", e.target.value)} placeholder="MY_SERVICE_API_KEY" />
                          </label>
                        </div>
                      </div>
                    ) : authMode === "bearer" ? (
                      <div className="entity-card">
                        <h3 className="entity-card-title">Bearer Token Configuration</h3>
                        <label className="entity-field">
                          <span className="entity-field-label">Token Env Var</span>
                          <input value={getField("auth.bearer.tokenEnvVar", mod.auth?.bearer?.tokenEnvVar ?? "")} onChange={(e) => setField("auth.bearer.tokenEnvVar", e.target.value)} placeholder="MY_SERVICE_BEARER_TOKEN" />
                        </label>
                      </div>
                    ) : (
                      <div className="entity-card">
                        <p className="entity-hint">No authentication is configured for this module.</p>
                      </div>
                    )}
                  </div>
                ) : activeSection === "headers" ? (
                  <div className="entity-section">
                    <div className="entity-card">
                      <h3 className="entity-card-title">Default Headers</h3>
                      <p className="entity-hint">These headers are automatically included in every request for this module.</p>
                      {(() => {
                        const headers = getField<Record<string, string>>("defaultHeaders", mod.defaultHeaders ?? {});
                        const entries = Object.entries(headers);

                        return entries.length === 0 ? (
                          <div className="default-headers-prompt">
                            <p className="entity-hint" style={{ margin: 0 }}>No default headers configured.</p>
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                setField("defaultHeaders", {
                                  "Cache-Control": "no-cache",
                                  "User-Agent": "RepoApiWrapper/1.0",
                                  "Accept": "*/*",
                                  "Accept-Encoding": "gzip, deflate, br",
                                  "Connection": "keep-alive",
                                })
                              }
                            >
                              Add default headers
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="entity-table">
                              <div className="entity-table-header">
                                <span className="entity-table-cell" style={{ flex: 1 }}>Key</span>
                                <span className="entity-table-cell" style={{ flex: 2 }}>Value</span>
                                <span className="entity-table-cell entity-table-action-col"></span>
                              </div>
                              {entries.map(([key, value], i) => (
                                <div key={i} className="entity-table-row">
                                  <span className="entity-table-cell" style={{ flex: 1 }}>
                                    <input value={key} onChange={(e) => {
                                      const newH = { ...headers };
                                      delete newH[key];
                                      newH[e.target.value] = value;
                                      setField("defaultHeaders", newH);
                                    }} placeholder="Header name" />
                                  </span>
                                  <span className="entity-table-cell" style={{ flex: 2 }}>
                                    <input value={value} onChange={(e) => setField("defaultHeaders", { ...headers, [key]: e.target.value })} placeholder="Value" />
                                  </span>
                                  <span className="entity-table-cell entity-table-action-col">
                                    <button type="button" className="remove-row-btn" onClick={() => {
                                      const newH = { ...headers };
                                      delete newH[key];
                                      setField("defaultHeaders", newH);
                                    }} title="Remove">&times;</button>
                                  </span>
                                </div>
                              ))}
                            </div>
                            <button type="button" className="ghost-button" style={{ marginTop: 8 }} onClick={() => {
                              setField("defaultHeaders", { ...headers, "": "" });
                            }}>+ Add header</button>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                ) : activeSection === "variables" ? (
                  <div className="entity-section">
                    <div className="entity-card">
                      <h3 className="entity-card-title">Collection Variables</h3>
                      <p className="entity-hint">Module-level variables that can be referenced as <code>{"{{varName}}"}</code> in URLs, headers, query params, and request bodies. Sidebar environment variables override these.</p>
                      {(() => {
                        const vars = getField<Record<string, string>>("variables", mod.variables ?? {});
                        const entries = Object.entries(vars);

                        return entries.length === 0 ? (
                          <div className="default-headers-prompt">
                            <p className="entity-hint" style={{ margin: 0 }}>No variables configured yet.</p>
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => setField("variables", { "": "" })}
                            >
                              + Add variable
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="entity-table">
                              <div className="entity-table-header">
                                <span className="entity-table-cell" style={{ flex: 1 }}>Name</span>
                                <span className="entity-table-cell" style={{ flex: 2 }}>Value</span>
                                <span className="entity-table-cell entity-table-action-col"></span>
                              </div>
                              {entries.map(([key, value], i) => (
                                <div key={i} className="entity-table-row">
                                  <span className="entity-table-cell" style={{ flex: 1 }}>
                                    <input value={key} onChange={(e) => {
                                      const newV = { ...vars };
                                      delete newV[key];
                                      newV[e.target.value] = value;
                                      setField("variables", newV);
                                    }} placeholder="Variable name" />
                                  </span>
                                  <span className="entity-table-cell" style={{ flex: 2 }}>
                                    <input value={value} onChange={(e) => setField("variables", { ...vars, [key]: e.target.value })} placeholder="Value" />
                                  </span>
                                  <span className="entity-table-cell entity-table-action-col">
                                    <button type="button" className="remove-row-btn" onClick={() => {
                                      const newV = { ...vars };
                                      delete newV[key];
                                      setField("variables", newV);
                                    }} title="Remove">&times;</button>
                                  </span>
                                </div>
                              ))}
                            </div>
                            <button type="button" className="ghost-button" style={{ marginTop: 8 }} onClick={() => {
                              setField("variables", { ...vars, "": "" });
                            }}>+ Add variable</button>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })()}

        {/* ── Endpoint Request Editor ────────────────────────────── */}
        {tabs.length > 0 && selectedEndpoint && tabs.find((t) => t.id === activeTabId)?.type !== "module-config" ? (
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
                <VarInput
                  className="url-path-input"
                  resolvedVars={availableVarNames}
                  urlMode
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
                Headers{(() => {
                  const userCount = formState.headers.filter((h) => h.key.trim()).length;
                  let inheritedCount = 0;
                  if (selectedModule?.auth?.mode && selectedModule.auth.mode !== "none") inheritedCount++;
                  inheritedCount += Object.keys(selectedModule?.defaultHeaders ?? {}).length;
                  const epH = selectedEndpoint?.defaultHeaders ?? (
                    selectedEndpoint?.defaultRunConfig?.headers && typeof selectedEndpoint.defaultRunConfig.headers === "object" && !Array.isArray(selectedEndpoint.defaultRunConfig.headers)
                      ? selectedEndpoint.defaultRunConfig.headers as Record<string, string> : null
                  );
                  inheritedCount += Object.keys(epH ?? {}).length;
                  const total = userCount + inheritedCount;
                  return total > 0 ? ` (${total})` : "";
                })()}
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
                  {/* ── Inherited & auth headers ─────────────────────────── */}
                  {(() => {
                    const inherited: Array<{ key: string; displayValue: string; source: string; isAuth: boolean }> = [];

                    if (selectedModule?.auth) {
                      const auth = selectedModule.auth;
                      if (auth.mode === "jwt") {
                        inherited.push({ key: "authorization", displayValue: "Bearer ••••••••", source: "Auth (JWT)", isAuth: true });
                      } else if (auth.mode === "apikey" && auth.apikey) {
                        inherited.push({ key: auth.apikey.headerName, displayValue: `••••••••  (${auth.apikey.valueEnvVar})`, source: "Auth (API Key)", isAuth: true });
                      } else if (auth.mode === "bearer") {
                        inherited.push({ key: "authorization", displayValue: "Bearer ••••••••", source: "Auth (Bearer)", isAuth: true });
                      }
                    }

                    if (selectedModule?.defaultHeaders) {
                      for (const [key, value] of Object.entries(selectedModule.defaultHeaders)) {
                        if (!inherited.some((h) => h.key.toLowerCase() === key.toLowerCase())) {
                          inherited.push({ key, displayValue: value, source: selectedModule.label, isAuth: false });
                        }
                      }
                    }

                    const epCfgHeaders =
                      selectedEndpoint?.defaultRunConfig?.headers &&
                      typeof selectedEndpoint.defaultRunConfig.headers === "object" &&
                      !Array.isArray(selectedEndpoint.defaultRunConfig.headers)
                        ? (selectedEndpoint.defaultRunConfig.headers as Record<string, string>)
                        : null;
                    const epDefHeaders = selectedEndpoint?.defaultHeaders ?? epCfgHeaders;
                    if (epDefHeaders) {
                      for (const [key, value] of Object.entries(epDefHeaders)) {
                        if (!inherited.some((h) => h.key.toLowerCase() === key.toLowerCase())) {
                          inherited.push({ key, displayValue: value, source: selectedEndpoint.label, isAuth: false });
                        }
                      }
                    }

                    if (inherited.length === 0) return null;

                    return (
                      <div className="query-params-section">
                        <span className="section-label">Inherited headers <span className="section-label-hint">Auto-included — uncheck to disable</span></span>
                        <div className="query-params-table">
                          {inherited.map((h) => {
                            const isDisabled = h.isAuth
                              ? formState.skipAuth
                              : formState.disabledDefaultHeaders.includes(h.key);
                            return (
                              <div key={`${h.isAuth ? "auth:" : ""}${h.key}`} className={`query-param-row collection-header-row${isDisabled ? " inherited-disabled" : ""}`}>
                                <label className="header-toggle-wrap">
                                  <input
                                    type="checkbox"
                                    checked={!isDisabled}
                                    onChange={() => {
                                      if (h.isAuth) {
                                        setFormState((cur) => ({ ...cur, skipAuth: !cur.skipAuth }));
                                      } else {
                                        setFormState((cur) => ({
                                          ...cur,
                                          disabledDefaultHeaders: isDisabled
                                            ? cur.disabledDefaultHeaders.filter((k) => k !== h.key)
                                            : [...cur.disabledDefaultHeaders, h.key],
                                        }));
                                      }
                                    }}
                                  />
                                </label>
                                <input className="query-param-key" value={h.key} readOnly tabIndex={-1} />
                                <input className="query-param-value" value={h.displayValue} readOnly tabIndex={-1} />
                                <span className="inherited-source">{h.source}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="query-params-section">
                    <span className="section-label">Request headers <span className="section-label-hint">Use <code>{"{{itemValue}}"}</code> to inject the current item</span></span>
                    <KeyValueTable rows={formState.headers} onChange={(rows) => setFormState((cur) => ({ ...cur, headers: rows }))} keyPlaceholder="Header name" resolvedVars={availableVarNames} />
                    <p className="section-hint">Per-request headers override inherited headers. Content-Type is set automatically.</p>
                  </div>
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
                    <KeyValueTable rows={formState.queryParams} onChange={(rows) => setFormState((cur) => ({ ...cur, queryParams: rows }))} resolvedVars={availableVarNames} />
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
                      <KeyValueTable rows={formState.formBodyRows} onChange={(rows) => setFormState((cur) => ({ ...cur, formBodyRows: rows }))} keyPlaceholder="Field name" resolvedVars={availableVarNames} />
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
                        {formState.bodyType === "json" ? (
                          <button
                            type="button"
                            className="beautify-btn"
                            onClick={() => {
                              try {
                                const parsed = JSON.parse(formState.requestBodyRaw);
                                setFormState((cur) => ({ ...cur, requestBodyRaw: JSON.stringify(parsed, null, 2) }));
                              } catch { /* ignore invalid json */ }
                            }}
                          >
                            Beautify
                          </button>
                        ) : null}
                      </span>
                      <VarTextarea
                        rows={10}
                        value={formState.requestBodyRaw}
                        resolvedVars={availableVarNames}
                        mono
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
                  <label className="param-field">
                    <span>Timeout (ms)</span>
                    <input
                      value={formState.timeoutMs}
                      onChange={(e) =>
                        setFormState((cur) => ({ ...cur, timeoutMs: e.target.value }))
                      }
                      placeholder="30000 (default)"
                    />
                  </label>
                  <label className="param-field param-field-inline">
                    <input
                      type="checkbox"
                      checked={formState.followRedirects}
                      onChange={(e) =>
                        setFormState((cur) => ({ ...cur, followRedirects: e.target.checked }))
                      }
                    />
                    <span>Follow redirects</span>
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
                      <button
                        className="ghost-button replay-btn"
                        onClick={() => void handleReplayRun()}
                        type="button"
                        title="Restore this run's config into the form"
                      >
                        Replay
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
                        {runDetail.status === "COMPLETED" || runDetail.status === "STOPPED" || runDetail.status === "FAILED" ? (
                          <span className="export-dropdown">
                            <button
                              className="ghost-button"
                              onClick={() => {
                                window.open(`/api/runs/${runDetail.id}/export?format=json`, "_blank");
                              }}
                              type="button"
                            >
                              Export
                            </button>
                            <button
                              className="ghost-button ghost-button-sm"
                              onClick={() => {
                                window.open(`/api/runs/${runDetail.id}/export?format=csv`, "_blank");
                              }}
                              type="button"
                              title="Export as CSV"
                            >
                              CSV
                            </button>
                          </span>
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
                              <input
                                className="inspector-search"
                                type="text"
                                placeholder="Search response…"
                                value={inspectorSearch}
                                onChange={(e) => setInspectorSearch(e.target.value)}
                              />
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
                                  {parsedResp.durationMs !== null ? (
                                    <span className="inspector-duration" title="HTTP request time">{parsedResp.durationMs < 1000 ? `${parsedResp.durationMs}ms` : `${(parsedResp.durationMs / 1000).toFixed(2)}s`}</span>
                                  ) : formatItemDuration(selectedItem) ? (
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
                                  <pre dangerouslySetInnerHTML={{ __html: highlightSearch(syntaxHighlightJson(parsedResp.body), inspectorSearch) }} />
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
                            <RunHistoryItem key={run.id} run={run} isActive={selectedRunId === run.id} onClick={() => setSelectedRunId(run.id)} />
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
                        <RunHistoryItem key={run.id} run={run} isActive={selectedRunId === run.id} onClick={() => setSelectedRunId(run.id)} />
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
                {tabs.length === 0 ? (
                  <><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></>
                ) : (
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                )}
              </svg>
            </div>
            <div>
              {tabs.length === 0 ? (
                <>
                  <p className="empty-workspace-label">No open tabs</p>
                  <p>Select an endpoint from the sidebar or click <strong>+</strong> to open a new tab.</p>
                </>
              ) : (
                <>
                  <p className="empty-workspace-label">Select an endpoint</p>
                  <p>Choose an endpoint from the collection sidebar to configure and run requests.</p>
                </>
              )}
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
