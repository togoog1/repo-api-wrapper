import { useRef, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

/* ── Highlight helpers ───────────────────────────────────────────── */

const VAR_RE = /\{\{([^}]*)\}\}/g;

/** Highlight `{{varName}}` syntax only */
function highlightVars(text: string, vars: Set<string>): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(VAR_RE.source, VAR_RE.flags);
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={`t${last}`}>{text.slice(last, m.index)}</span>);
    const name = m[1].trim();
    parts.push(
      <span key={`v${m.index}`} className={vars.has(name) ? "var-hl-resolved" : "var-hl-unresolved"}>
        {m[0]}
      </span>,
    );
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(<span key={`t${last}`}>{text.slice(last)}</span>);
  return parts;
}

/** Highlight both `{{varName}}` and `:pathToken` patterns (for URLs) */
function highlightUrlVars(text: string, vars: Set<string>): ReactNode[] {
  // Combined regex: {{varName}} OR :word_token (not followed by more word chars)
  const URL_RE = /\{\{([^}]*)\}\}|(?<=\/):([A-Za-z_]\w*)\b/g;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={`t${last}`}>{text.slice(last, m.index)}</span>);
    if (m[1] !== undefined) {
      // {{varName}} match
      const name = m[1].trim();
      parts.push(
        <span key={`v${m.index}`} className={vars.has(name) ? "var-hl-resolved" : "var-hl-unresolved"}>
          {m[0]}
        </span>,
      );
    } else {
      // :pathToken match
      parts.push(
        <span key={`p${m.index}`} className="var-hl-path-token">
          {m[0]}
        </span>,
      );
    }
    last = URL_RE.lastIndex;
  }
  if (last < text.length) parts.push(<span key={`t${last}`}>{text.slice(last)}</span>);
  return parts;
}

function hasVarSyntax(text: string): boolean {
  return /\{\{.+?\}\}/.test(text);
}

function hasUrlHighlights(text: string): boolean {
  return /\{\{.+?\}\}|(?<=\/):([A-Za-z_]\w*)\b/.test(text);
}

/* ── VarInput ────────────────────────────────────────────────────── */

interface VarInputProps extends InputHTMLAttributes<HTMLInputElement> {
  value: string;
  resolvedVars: Set<string>;
  /** Also highlight :pathToken patterns (for URL bars) */
  urlMode?: boolean;
}

/**
 * Drop-in `<input>` replacement that highlights `{{varName}}` syntax.
 * With `urlMode`, also highlights `:pathToken` patterns.
 */
export function VarInput({ value, resolvedVars, className, urlMode, ...rest }: VarInputProps) {
  const hasHL = urlMode ? hasUrlHighlights(value) : hasVarSyntax(value);
  if (!hasHL) {
    return <input value={value} className={className} {...rest} />;
  }
  const nodes = urlMode ? highlightUrlVars(value, resolvedVars) : highlightVars(value, resolvedVars);
  return (
    <span className={`${className ?? ""} var-hl-wrap`}>
      <input value={value} className={`${className ?? ""} var-hl-field`} {...rest} />
      <span className="var-hl-mirror" aria-hidden="true">
        {nodes}{"\u00A0"}
      </span>
    </span>
  );
}

/* ── VarTextarea ─────────────────────────────────────────────────── */

interface VarTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string;
  resolvedVars: Set<string>;
  /** Add "var-hl-mono" to the wrapper for monospace body textareas */
  mono?: boolean;
}

/**
 * Drop-in `<textarea>` replacement that highlights `{{varName}}` syntax
 * with scroll-synced mirror overlay.
 */
export function VarTextarea({ value, resolvedVars, className, mono, ...rest }: VarTextareaProps) {
  const mirrorRef = useRef<HTMLDivElement>(null);

  if (!hasVarSyntax(value)) {
    return <textarea value={value} className={className} {...rest} />;
  }

  return (
    <span className={`var-hl-wrap var-hl-wrap-multi${mono ? " var-hl-mono" : ""}`}>
      <textarea
        value={value}
        className={`${className ?? ""} var-hl-field`}
        onScroll={(e) => {
          if (mirrorRef.current) {
            mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
            mirrorRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        {...rest}
      />
      <div className="var-hl-mirror var-hl-mirror-multi" ref={mirrorRef} aria-hidden="true">
        {highlightVars(value, resolvedVars)}{"\n "}
      </div>
    </span>
  );
}
