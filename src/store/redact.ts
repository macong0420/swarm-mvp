const secrets = new Set<string>();
const MIN_SECRET_LENGTH = 8;

/** Register a value that must never appear in the event log. Short values are ignored to avoid noisy replacement. */
export function registerSecret(value: string): void {
  if (value.length >= MIN_SECRET_LENGTH) secrets.add(value);
}

/** Replace every registered secret in strings, recursively through objects and arrays. Best effort, not encryption. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redact(entry)]));
  }
  return value;
}
