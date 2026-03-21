import { escapeHtml } from "./layout.js";

export function withCompany(path: string, companySlug?: string): string {
  if (!companySlug) return path;
  const url = new URL(path, "http://localhost");
  url.searchParams.set("company", companySlug);
  return url.pathname + url.search;
}

export function buildDetailUrl(path: string, companySlug?: string, returnTo?: string): string {
  const url = new URL(path, "http://localhost");
  if (companySlug) url.searchParams.set("company", companySlug);
  if (returnTo) url.searchParams.set("returnTo", returnTo);
  return url.pathname + url.search;
}

export function backLink(returnTo: string | undefined): string {
  if (!returnTo || !returnTo.startsWith("/admin")) return "";
  return `<p><a href="${escapeHtml(returnTo)}">&laquo; Back to list</a></p>`;
}

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return `<div class="empty">No items found.</div>`;
  }
  const ths = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const trs = rows
    .map((row) => {
      const tds = row.map((cell) => `<td>${cell}</td>`).join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

export function pagination(
  currentPage: number,
  totalPages: number,
  baseUrl: string
): string {
  if (totalPages <= 1) return "";
  const links: string[] = [];

  if (currentPage > 1) {
    links.push(`<a href="${setPage(baseUrl, currentPage - 1)}">&laquo; Prev</a>`);
  }

  const start = Math.max(1, currentPage - 3);
  const end = Math.min(totalPages, currentPage + 3);

  if (start > 1) links.push(`<a href="${setPage(baseUrl, 1)}">1</a>`);
  if (start > 2) links.push(`<span>…</span>`);

  for (let i = start; i <= end; i++) {
    if (i === currentPage) {
      links.push(`<span class="active">${i}</span>`);
    } else {
      links.push(`<a href="${setPage(baseUrl, i)}">${i}</a>`);
    }
  }

  if (end < totalPages - 1) links.push(`<span>…</span>`);
  if (end < totalPages) links.push(`<a href="${setPage(baseUrl, totalPages)}">${totalPages}</a>`);

  if (currentPage < totalPages) {
    links.push(`<a href="${setPage(baseUrl, currentPage + 1)}">Next &raquo;</a>`);
  }

  return `<div class="pagination">${links.join("")}</div>`;
}

function setPage(baseUrl: string, page: number): string {
  const url = new URL(baseUrl, "http://localhost");
  url.searchParams.set("page", String(page));
  return escapeHtml(url.pathname + url.search);
}

export function filterForm(
  fields: { name: string; label: string; type: "select" | "text"; options?: { value: string; label: string }[] }[],
  currentValues: Record<string, string>,
  action: string,
  hiddenFields?: Record<string, string>
): string {
  const hiddens = hiddenFields
    ? Object.entries(hiddenFields)
        .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
        .join("")
    : "";
  const inputs = fields
    .map((f) => {
      if (f.type === "select" && f.options) {
        const opts = f.options
          .map((o) => {
            const selected = currentValues[f.name] === o.value ? " selected" : "";
            return `<option value="${escapeHtml(o.value)}"${selected}>${escapeHtml(o.label)}</option>`;
          })
          .join("");
        return `<select name="${escapeHtml(f.name)}"><option value="">${escapeHtml(f.label)}</option>${opts}</select>`;
      }
      const val = currentValues[f.name] ?? "";
      return `<input type="text" name="${escapeHtml(f.name)}" placeholder="${escapeHtml(f.label)}" value="${escapeHtml(val)}">`;
    })
    .join("");
  return `<form method="GET" action="${escapeHtml(action)}" class="filter-bar">${hiddens}${inputs}<button type="submit">Filter</button></form>`;
}

export function badge(text: string, color: "blue" | "green" | "red" | "orange" | "gray" | "purple"): string {
  return `<span class="badge badge-${color}">${escapeHtml(text)}</span>`;
}

export function jsonViewer(data: unknown): string {
  const formatted = JSON.stringify(data, null, 2);
  return `<pre><code>${escapeHtml(formatted)}</code></pre>`;
}

export function linkTo(path: string, text: string): string {
  return `<a href="${escapeHtml(path)}">${escapeHtml(text)}</a>`;
}

export function statCard(label: string, value: string | number): string {
  return `<div class="stat-card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div></div>`;
}

export function detailSection(title: string, content: string): string {
  return `<div class="detail-section"><h2>${escapeHtml(title)}</h2>${content}</div>`;
}

export function collapsible(summary: string, content: string): string {
  return `<details><summary>${escapeHtml(summary)}</summary>${content}</details>`;
}

export function sourceBadge(source: string): string {
  const colors: Record<string, "blue" | "green" | "orange" | "purple" | "gray"> = {
    claap: "purple",
    linear: "blue",
    notion: "green",
    "market-findings": "orange",
    "market-research": "orange"
  };
  return badge(source, colors[source] ?? "gray");
}

export function statusBadge(status: string): string {
  const colors: Record<string, "blue" | "green" | "red" | "orange" | "gray"> = {
    "To review": "blue",
    "Needs routing": "orange",
    "To enrich": "orange",
    "Ready for V1": "blue",
    "V1 generated": "green",
    Selected: "green",
    "V2 in progress": "blue",
    "Waiting approval": "orange",
    Rejected: "red",
    Archived: "gray"
  };
  return badge(status, colors[status] ?? "gray");
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toISOString().slice(0, 16).replace("T", " ");
}
