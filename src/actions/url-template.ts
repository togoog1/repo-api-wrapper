const MASTER_ID_TOKEN_PATTERNS = [":master_id", "{master_id}"] as const;

export function hasMasterIdToken(pathTemplate: string): boolean {
  return MASTER_ID_TOKEN_PATTERNS.some((token) => pathTemplate.includes(token));
}

export function normalizePathTemplate(pathTemplate: string): string {
  const trimmed = pathTemplate.trim();

  if (!trimmed) {
    throw new Error("Path template cannot be empty.");
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function interpolateMasterId(pathTemplate: string, masterId: number): string {
  return MASTER_ID_TOKEN_PATTERNS.reduce(
    (value, token) => value.replaceAll(token, String(masterId)),
    normalizePathTemplate(pathTemplate)
  );
}

export function buildRequestUrl(
  baseUrl: string,
  pathTemplate: string,
  masterId: number
): URL {
  return new URL(interpolateMasterId(pathTemplate, masterId), baseUrl);
}
