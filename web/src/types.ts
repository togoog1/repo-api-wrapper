export type RunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "STOPPED" | "FAILED";
export type RunItemStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "STOPPED";
export type TargetEnvironment = "staging" | "prod";

export interface Tab {
  id: string;
  type: "endpoint" | "module-config";
  endpointSlug?: string;
  moduleSlug: string;
  method?: string;
  label: string;
  pinned: boolean;
}

export interface RunSummary {
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

export interface RunEvent {
  id: string;
  runItemId: string | null;
  level: string;
  eventType: string;
  message: string;
  data: unknown;
  createdAt: string;
}

export interface RunItem {
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

export interface RunDetail extends RunSummary {
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

export interface QueryParamRow {
  key: string;
  value: string;
}

export interface CreateRunFormState {
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
  skipAuth: boolean;
  disabledDefaultHeaders: string[];
  timeoutMs: string;
  followRedirects: boolean;
}

export interface ModuleEndpointCatalog {
  slug: string;
  action: string;
  label: string;
  description: string;
  method: string;
  pathTemplate: string;
  folder?: string[];
  defaultHeaders?: Record<string, string>;
  requestBodyDescription?: string;
  notes?: string;
  defaultRunLabel?: string;
  defaultRunConfig?: Record<string, unknown> | null;
}

export interface ModuleCatalog {
  slug: string;
  serviceName: string;
  label: string;
  description: string | null;
  defaultTargetEnvironment: TargetEnvironment;
  environments: Record<TargetEnvironment, { baseUrl: string }>;
  auth: {
    mode: "jwt" | "apikey" | "bearer" | "none";
    secretEnvVar?: string;
    secretEnvVarByEnvironment?: Partial<Record<TargetEnvironment, string>>;
    jwt?: {
      email: string;
      subject?: string;
      issuer?: string;
      audience?: string;
      expiresInSeconds?: number;
    };
    apikey?: {
      headerName: string;
      valueEnvVar: string;
    };
    bearer?: {
      tokenEnvVar: string;
    };
  };
  defaultHeaders?: Record<string, string>;
  variables?: Record<string, string>;
  customFolders?: string[][];
  endpoints: ModuleEndpointCatalog[];
}

export interface RuntimeConfig {
  defaultTargetEnvironment: TargetEnvironment;
  availableTargetEnvironments: TargetEnvironment[];
  authMode: "jwt" | "apikey" | "bearer" | "none" | "unconfigured";
  jwtEmail: string | null;
  serviceName: string;
  tokenCacheStrategy: "memory";
  targetBaseUrls: Record<TargetEnvironment, string>;
  modules: ModuleCatalog[];
}

export interface SavedInputList {
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

export interface ParsedItemResponse {
  body: unknown;
  headers: Record<string, string>;
  size: number | null;
  durationMs: number | null;
}

export interface NavFolderNode {
  name: string;
  key: string;
  children: NavFolderNode[];
  endpoints: ModuleEndpointCatalog[];
}

export const defaultFormState: CreateRunFormState = {
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
  skipAuth: false,
  disabledDefaultHeaders: [],
  timeoutMs: "",
  followRedirects: true,
};
