import type { QueryParamRow } from "../types";
import { VarInput } from "./VarHighlight";

interface KeyValueTableProps {
  rows: QueryParamRow[];
  onChange: (rows: QueryParamRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** When provided, value inputs highlight resolved `{{varName}}` syntax */
  resolvedVars?: Set<string>;
}

export function KeyValueTable({ rows, onChange, keyPlaceholder = "Key", valuePlaceholder = "Value", resolvedVars }: KeyValueTableProps) {
  function updateRow(index: number, field: "key" | "value", newValue: string) {
    const next = rows.map((r, j) => (j === index ? { ...r, [field]: newValue } : r));
    const last = next[next.length - 1];
    if (last.key || last.value) next.push({ key: "", value: "" });
    onChange(next);
  }

  return (
    <div className="query-params-table">
      {rows.map((row, i) => (
        <div key={i} className="query-param-row">
          <input
            className="query-param-key"
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(e) => updateRow(i, "key", e.target.value)}
          />
          {resolvedVars ? (
            <VarInput
              className="query-param-value"
              placeholder={valuePlaceholder}
              value={row.value}
              resolvedVars={resolvedVars}
              onChange={(e) => updateRow(i, "value", e.target.value)}
            />
          ) : (
            <input
              className="query-param-value"
              placeholder={valuePlaceholder}
              value={row.value}
              onChange={(e) => updateRow(i, "value", e.target.value)}
            />
          )}
          {row.key || row.value ? (
            <button
              type="button"
              className="remove-param-btn"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >×</button>
          ) : <span className="remove-param-btn" />}
        </div>
      ))}
    </div>
  );
}
