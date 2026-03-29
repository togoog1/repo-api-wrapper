export function parseInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    throw new Error(`${optionName} must be an integer`);
  }

  return parsed;
}

export function parseCommaSeparatedIntegers(rawValue?: string): number[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseInteger(value, "value"));
}
