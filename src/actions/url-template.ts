const PATH_TOKEN_REGEX = /:[a-z][a-z0-9_]*|\{[a-z][a-z0-9_]*\}/giu;

export function normalizePathTemplate(pathTemplate: string): string {
  const trimmed = pathTemplate.trim();

  if (!trimmed) {
    throw new Error("Path template cannot be empty.");
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function interpolateItemValue(pathTemplate: string, itemValue: string): string {
  const path = normalizePathTemplate(pathTemplate);

  // Try JSON object for multi-token paths: {"adset_id":"101","tesg":"a"}
  try {
    const parsed = JSON.parse(itemValue) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const valueMap = parsed as Record<string, string>;
      return path.replace(PATH_TOKEN_REGEX, (match) => {
        const name = match.replace(/^[:{]|\}$/gu, "");
        return valueMap[name] ?? match;
      });
    }
  } catch {
    // not JSON — fall through to single-value replacement
  }

  // Single value: replace all tokens with the same value
  return path.replace(PATH_TOKEN_REGEX, itemValue);
}

export function buildRequestUrl(
  baseUrl: string,
  pathTemplate: string,
  itemValue: string,
  queryParams?: Record<string, string>
): URL {
  // Resolve {{itemValue}} display value for query param substitution
  let displayValue = itemValue;
  try {
    const parsed = JSON.parse(itemValue) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = Object.values(parsed as Record<string, string>);
      displayValue = values[0] ?? itemValue;
    }
  } catch {
    // plain value
  }

  const url = new URL(interpolateItemValue(pathTemplate, itemValue), baseUrl);
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (key) url.searchParams.append(key, value.replace(/\{\{itemValue\}\}/gu, displayValue));
    }
  }
  return url;
}
