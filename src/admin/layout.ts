export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function layout(
  title: string,
  content: string,
  companyName?: string,
  companySlug?: string
): string {
  const companyLabel = companyName ? escapeHtml(companyName) : "No company";
  const qs = companySlug ? `?company=${escapeHtml(companySlug)}` : "";
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Fresh Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0; color: #1a1a1a; background: #f5f5f5; font-size: 14px; }
    nav { background: #1a1a1a; color: #fff; padding: 10px 20px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
    nav a { color: #a0cfff; text-decoration: none; font-size: 13px; }
    nav a:hover { text-decoration: underline; }
    nav .brand { font-weight: 700; font-size: 15px; color: #fff; margin-right: 10px; }
    nav .company { color: #999; font-size: 12px; margin-left: auto; }
    main { max-width: 1200px; margin: 20px auto; padding: 0 20px; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 4px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th { background: #f0f0f0; text-align: left; padding: 8px 12px; font-size: 12px; text-transform: uppercase; color: #666; border-bottom: 2px solid #ddd; }
    td { padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 13px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr:hover td { background: #fafafa; }
    a { color: #0066cc; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .badge-blue { background: #e3f2fd; color: #1565c0; }
    .badge-green { background: #e8f5e9; color: #2e7d32; }
    .badge-red { background: #ffebee; color: #c62828; }
    .badge-orange { background: #fff3e0; color: #e65100; }
    .badge-gray { background: #f5f5f5; color: #616161; }
    .badge-purple { background: #f3e5f5; color: #6a1b9a; }
    .filter-bar { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
    .filter-bar select, .filter-bar input[type="text"] { padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
    .filter-bar button { padding: 6px 14px; background: #1a1a1a; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .pagination { display: flex; gap: 6px; margin: 16px 0; align-items: center; }
    .pagination a, .pagination span { padding: 4px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; text-decoration: none; }
    .pagination .active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .stat-card { background: #fff; padding: 16px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .stat-card .label { font-size: 12px; color: #666; text-transform: uppercase; }
    .stat-card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
    .detail-section { background: #fff; padding: 16px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 16px; }
    .detail-section h2 { font-size: 14px; text-transform: uppercase; color: #666; margin: 0 0 10px; }
    pre { background: #f8f8f8; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; max-height: 400px; overflow-y: auto; }
    details { margin-bottom: 8px; }
    summary { cursor: pointer; font-weight: 600; font-size: 13px; }
    .empty { text-align: center; padding: 40px; color: #999; }
  </style>
</head><body>
  <nav>
    <span class="brand">Fresh Admin</span>
    <a href="/admin${qs}">Dashboard</a>
    <a href="/admin/source-items${qs}">Source Items</a>
    <a href="/admin/opportunities${qs}">Opportunities</a>
    <a href="/admin/drafts${qs}">Drafts</a>
    <a href="/admin/reviews/claap${qs}">Claap Review</a>
    <a href="/admin/reviews/linear${qs}">Linear Review</a>
    <a href="/admin/runs${qs}">Runs</a>
    <a href="/admin/users${qs}">Users</a>
    <a href="/admin/editorial-configs${qs}">Doctrine</a>
    <a href="/admin/source-configs${qs}">Sources</a>
    <a href="/admin/market-queries${qs}">Market Queries</a>
    <span class="company">${companyLabel}</span>
  </nav>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${content}
  </main>
</body></html>`;
}
