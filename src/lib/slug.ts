import { randomBytes } from "node:crypto";

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function createRunSlug(base: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .toLowerCase();
  const suffix = randomBytes(2).toString("hex");

  return `${slugify(base)}-${timestamp}-${suffix}`;
}
