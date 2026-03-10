import { createHash, randomUUID } from "node:crypto";

export function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashParts(parts: Array<string | number | boolean | null | undefined>) {
  return hashText(
    parts
      .filter((part) => part !== undefined && part !== null)
      .map((part) => String(part).trim())
      .join("|")
  );
}

export function createDeterministicId(prefix: string, parts: Array<string | number | boolean | null | undefined>) {
  return `${prefix}_${hashParts(parts).slice(0, 24)}`;
}
