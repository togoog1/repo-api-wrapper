import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  CreateRunFormState, ModuleCatalog, ModuleConfigDraft, ModuleEndpointCatalog, NavFolderNode,
  QueryParamRow, RunDetail, RunEvent, RunItem, RunItemStatus,
  RunSummary, RuntimeConfig, SavedInputList, Tab, TargetEnvironment,
} from "./types";
import { defaultFormState } from "./types";
import {
  applyEnvVars, applyCatalogDefaults, buildFolderTree, buildPreviewUrl,
  countTreeEndpoints, exportAsPostman, extractAllPathTokens, formatBytes,
  formatConfigValue, formatDate, formatInputListData, formatRuntime,
  formatStructuredValue, getSelectedEndpoint, getSelectedModule,
  highlightSearch, jsonEqual, parseIdList, parseItemResponse,
  recordToRows, requestJson, safeNum, safeStr,
  syntaxHighlightJson, useClickOutside, useDragResize, useFlash, usePolling,
} from "./helpers";
import { KeyValueTable } from "./components/KeyValueTable";
import { Modal } from "./components/Modal";
import { RunHistoryItem } from "./components/RunHistoryItem";
import { VarInput, VarTextarea } from "./components/VarHighlight";
import { ClockIcon, CopyIcon, FolderIcon, GearIcon, ListIcon, MonitorIcon, SearchIcon, SendIcon, SunIcon } from "./components/Icons";
import ModuleConfigEditor from "./components/ModuleConfigEditor";
import { InheritedHeaders } from "./components/InheritedHeaders";
import { FolderNode } from "./components/FolderNode";
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
  const [moduleConfigDrafts, setModuleConfigDrafts] = useState<Record<string, ModuleConfigDraft>>({});
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
  const requestPanelRef = useRef<HTMLDivElement>(null);

  /* derived helpers */
  const flash = useFlash(setSuccessMessage);
  const handleResizeMouseDown = useDragResize("y", setRequestPanelHeight, 60);
  const handleSidebarResize = useDragResize("x", setSidebarWidth, 180, 600);

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
      setRuns((prev) => jsonEqual(prev, response) ? prev : response);
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
      setRunDetail((prev) => jsonEqual(prev, detail) ? prev : detail);
      setItems((prev) => jsonEqual(prev, itemsRes) ? prev : itemsRes);
      setEvents((prev) => jsonEqual(prev, eventsRes) ? prev : eventsRes);
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
      flash(`Saved "${created.label}" (${created.itemCount} items)`, 4000);
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
      flash(`Failures saved as "${created.label}"`, 4000);
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
      flash("Input list deleted.");
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
    flash(`Loaded "${il.label}" (${il.itemCount} items)`);
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
      flash(`Imported "${result.label}" with ${result.endpointCount} endpoints → ${result.filename}`, 5000);
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
    const headerRows = recordToRows(cfg.headers);
    const qpRows = recordToRows(cfg.queryParams);
    const formRows = recordToRows(cfg.formBody);

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
              type: "endpoint" as const,
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

    flash("Restored form from previous run config.");
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
    flash("CLI command copied to clipboard.");
  }

  function formatItemDuration(item: RunItem): string | null {
    if (!item.startedAt) return null;
    const end = item.finishedAt ? new Date(item.finishedAt).getTime() : Date.now();
    const ms = end - new Date(item.startedAt).getTime();
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  function handleExportAsPostman(mod: ModuleCatalog) {
    exportAsPostman(mod, formState.targetEnvironment);
  }

  function handleCopyPathTemplate(ep: ModuleEndpointCatalog) {
    void navigator.clipboard.writeText(ep.pathTemplate);
    flash(`Copied: ${ep.pathTemplate}`);
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
      flash("Request added.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create request");
    }
  }

  // Close context menus on outside click
  useClickOutside(contextMenuEndpoint, () => setContextMenuEndpoint(null));
  useClickOutside(moduleMenu, () => setModuleMenu(null), ".module-context-menu");
  useClickOutside(folderContextMenu, () => setFolderContextMenu(null));
  useClickOutside(multiSelectMenu, () => setMultiSelectMenu(null));

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
      flash("Module config saved.");
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
      flash("Overrides baked into .ts file. Backup created.", 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rewrite module file");
    } finally {
      setBaking(false);
    }
  }

  useClickOutside(sendMenuOpen || null, () => setSendMenuOpen(false));


  /* ── Render ────────────────────────────────────────────────────── */
  return (
    <div className="shell">
      {/* ── Icon Rail (far left) ──────────────────────────────────── */}
      <div className="icon-rail">
        <button className={`rail-btn ${sidebarView === "collections" ? "active" : ""}`} type="button" title="Collections" onClick={() => setSidebarView("collections")}>
          <FolderIcon />
        </button>
        <button className={`rail-btn ${sidebarView === "history" ? "active" : ""}`} type="button" title="History" onClick={() => { setSidebarView("history"); void loadRuns(); }}>
          <ClockIcon />
        </button>
        <button className={`rail-btn ${sidebarView === "input-lists" ? "active" : ""}`} type="button" title="Input Lists" onClick={() => { setSidebarView("input-lists"); void loadInputLists(); }}>
          <ListIcon />
        </button>
        <button className={`rail-btn ${sidebarView === "env" ? "active" : ""}`} type="button" title="Environment Variables" onClick={() => setSidebarView("env")}>
          <SunIcon />
        </button>
        <div className="rail-spacer" />
        <button className={`rail-btn ${sidebarView === "settings" ? "active" : ""}`} type="button" title="Settings" onClick={() => setSidebarView("settings")}>
          <GearIcon />
        </button>
      </div>

      {/* ── Sidebar ────────────────────────────────────────────────── */}
      <div className="sidebar" style={{ width: sidebarWidth }}>
        <div className="sidebar-resize-handle" onMouseDown={handleSidebarResize} />
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
                    onClick={() => handleExportAsPostman(selectedModule)}
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
                <SearchIcon />
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
                      ? modTree.children.map((child) => (
                          <FolderNode
                            key={child.key}
                            node={child}
                            depth={1}
                            mod={mod}
                            openFolders={openFolders}
                            toggleFolder={toggleFolder}
                            activeTab={activeTab}
                            formState={formState}
                            selectedEndpoints={selectedEndpoints}
                            handleEndpointClick={handleEndpointClick}
                            handleEndpointContextMenu={handleEndpointContextMenu}
                            setContextMenuEndpoint={setContextMenuEndpoint}
                            setFolderContextMenu={setFolderContextMenu}
                          />
                        ))
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
                            flash(`Copied ${il.itemCount} IDs.`);
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
              flash("Full URL copied.");
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
            <button type="button" onClick={() => { handleExportAsPostman(mod); setModuleMenu(null); }}>Export as Postman</button>
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
            flash(`Copied ${eps.length} paths.`);
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
          return (
            <ModuleConfigEditor
              slug={cfgSlug}
              cfgState={cfgState}
              saving={moduleConfigSaving}
              onDraftsChange={setModuleConfigDrafts}
              onSave={(s) => void saveModuleConfig(s)}
              onBake={setBakeConfirmSlug}
            />
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
                    onClick={() => { void navigator.clipboard.writeText(previewUrl); flash("URL copied!"); }}
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
                  <InheritedHeaders
                    selectedModule={selectedModule}
                    selectedEndpoint={selectedEndpoint}
                    formState={formState}
                    setFormState={setFormState}
                  />

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
                                          <CopyIcon size={14} />
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
                              const copyIcon = <CopyIcon />;
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
                                      onClick={() => { void navigator.clipboard.writeText(formatStructuredValue(selectedItem.request)); flash("Request copied!"); }}>
                                      {copyIcon}
                                    </button>
                                  </div>
                                  <pre dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(selectedItem.request) }} />
                                </div>
                                <div className="inspector-block">
                                  <div className="inspector-block-header">
                                    <span>Response body</span>
                                    <button type="button" className="copy-col-btn" title="Copy response"
                                      onClick={() => { void navigator.clipboard.writeText(formatStructuredValue(parsedResp.body)); flash("Response copied!"); }}>
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
                                        onClick={() => { void navigator.clipboard.writeText(respHeaderEntries.map(([k, v]) => `${k}: ${v}`).join("\n")); flash("Headers copied!"); }}>
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
                                        onClick={() => { void navigator.clipboard.writeText(selectedItem.lastError ?? ""); flash("Error copied!"); }}>
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
                        <SendIcon />
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
              {tabs.length === 0 ? <MonitorIcon /> : <FolderIcon size={28} />}
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
