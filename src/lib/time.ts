export function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function nowIso() {
  return new Date().toISOString();
}

export function daysAgo(days: number, from = new Date()) {
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}
