import type { Dispatch, SetStateAction } from "react";
import type { ModuleCatalog, ModuleConfigDraft } from "../types";

interface Props {
  slug: string;
  cfgState: ModuleConfigDraft;
  saving: boolean;
  onDraftsChange: Dispatch<SetStateAction<Record<string, ModuleConfigDraft>>>;
  onSave: (slug: string) => void;
  onBake: (slug: string) => void;
}

export default function ModuleConfigEditor({ slug, cfgState, saving, onDraftsChange, onSave, onBake }: Props) {
  const { module: mod, draft, activeSection } = cfgState;

  /* ── Field helpers ───────────────────────────────────────── */

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
    onDraftsChange((prev) => {
      const entry = prev[slug];
      if (!entry) return prev;
      const newDraft = JSON.parse(JSON.stringify(entry.draft)) as Record<string, unknown>;
      let cursor = newDraft;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in cursor) || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {};
        cursor = cursor[parts[i]] as Record<string, unknown>;
      }
      cursor[parts[parts.length - 1]] = value;
      return { ...prev, [slug]: { ...entry, draft: newDraft } };
    });
  };

  const setSection = (s: string) => {
    onDraftsChange((prev) => {
      const entry = prev[slug];
      if (!entry) return prev;
      return { ...prev, [slug]: { ...entry, activeSection: s } };
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
              disabled={saving}
              onClick={() => onSave(slug)}
            >{saving ? "Saving\u2026" : "Save"}</button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => onBake(slug)}
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
          <GeneralSection getField={getField} setField={setField} mod={mod} />
        ) : activeSection === "environments" ? (
          <EnvironmentsSection getField={getField} setField={setField} mod={mod} />
        ) : activeSection === "auth" ? (
          <AuthSection getField={getField} setField={setField} mod={mod} authMode={authMode} />
        ) : activeSection === "headers" ? (
          <HeadersSection getField={getField} setField={setField} mod={mod} />
        ) : activeSection === "variables" ? (
          <VariablesSection getField={getField} setField={setField} mod={mod} />
        ) : null}
      </div>
    </div>
  );
}

/* ── Sub-sections ──────────────────────────────────────────── */

type FieldHelpers = {
  getField: <T>(path: string, fallback: T) => T;
  setField: (path: string, value: unknown) => void;
  mod: ModuleCatalog;
};

function GeneralSection({ getField, setField, mod }: FieldHelpers) {
  return (
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
  );
}

function EnvironmentsSection({ getField, setField, mod }: FieldHelpers) {
  const envs = getField<Record<string, { baseUrl: string }>>("environments", mod.environments ?? {});
  return (
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
          {Object.entries(envs).map(([envKey, envVal]) => (
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
          ))}
        </div>
        <button type="button" className="ghost-button" style={{ marginTop: 8 }} onClick={() => {
          setField("environments", { ...envs, "": { baseUrl: "" } });
        }}>+ Add environment</button>
      </div>
    </div>
  );
}

function AuthSection({ getField, setField, mod, authMode }: FieldHelpers & { authMode: string }) {
  return (
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
  );
}

function HeadersSection({ getField, setField, mod }: FieldHelpers) {
  const headers = getField<Record<string, string>>("defaultHeaders", mod.defaultHeaders ?? {});
  const entries = Object.entries(headers);

  return (
    <div className="entity-section">
      <div className="entity-card">
        <h3 className="entity-card-title">Default Headers</h3>
        <p className="entity-hint">These headers are automatically included in every request for this module.</p>
        {entries.length === 0 ? (
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
        )}
      </div>
    </div>
  );
}

function VariablesSection({ getField, setField, mod }: FieldHelpers) {
  const vars = getField<Record<string, string>>("variables", mod.variables ?? {});
  const entries = Object.entries(vars);

  return (
    <div className="entity-section">
      <div className="entity-card">
        <h3 className="entity-card-title">Collection Variables</h3>
        <p className="entity-hint">Module-level variables that can be referenced as <code>{"{{varName}}"}</code> in URLs, headers, query params, and request bodies. Sidebar environment variables override these.</p>
        {entries.length === 0 ? (
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
        )}
      </div>
    </div>
  );
}
