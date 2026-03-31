const PATH_TOKEN_REGEX = /:[a-z][a-z0-9_]*|\{[a-z][a-z0-9_]*\}/giu;

export function normalizePathTemplate(pathTemplate: string): string {
  const trimmed = pathTemplate.trim();

  if (!trimmed) {
    throw new Error("Path template cannot be empty.");
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function interpolateItemValue(pathTemplate: string, itemValue: string): string {
  return normalizePathTemplate(pathTemplate).replace(PATH_TOKEN_REGEX, itemValue);
}

export function buildRequestUrl(
  baseUrl: string,
  pathTemplate: string,
  itemValue: string,
  queryParams?: Record<string, string>
): URL {
  const url = new URL(interpolateItemValue(pathTemplate, itemValue), baseUrl);
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (key) url.searchParams.append(key, value.replace(/\{\{itemValue\}\}/gu, itemValue));
    }
  }
  return url;
}
