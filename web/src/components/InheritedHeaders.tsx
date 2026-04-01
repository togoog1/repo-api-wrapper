import type { Dispatch, SetStateAction } from "react";
import type { CreateRunFormState, ModuleCatalog, ModuleEndpointCatalog } from "../types";

interface Props {
  selectedModule: ModuleCatalog | null | undefined;
  selectedEndpoint: ModuleEndpointCatalog | undefined;
  formState: CreateRunFormState;
  setFormState: Dispatch<SetStateAction<CreateRunFormState>>;
}

export function InheritedHeaders({ selectedModule, selectedEndpoint, formState, setFormState }: Props) {
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
        inherited.push({ key, displayValue: value, source: selectedEndpoint!.label, isAuth: false });
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
}
