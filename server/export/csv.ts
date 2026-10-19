// RFC 4180 CSV serialisation for the study exports (docs/data-model.md §8).
// Rules: header row = columns; CRLF line endings; booleans TRUE/FALSE; null/undefined -> empty;
// arrays pipe-joined (no spaces); numbers as-is; fields containing comma, quote, CR or LF are
// wrapped in double quotes with inner quotes doubled.

const CRLF = "\r\n";

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(cellText).join("|");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function escapeCell(value: unknown): string {
  const s = cellText(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.map(escapeCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => escapeCell(row[c])).join(","));
  return lines.join(CRLF) + CRLF;
}
