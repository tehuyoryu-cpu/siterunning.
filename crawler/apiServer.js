'use strict';

/**
 * crawler/apiServer.js
 * Built-in http API server + embedded dashboard HTML.
 * No external dependencies – works inside the pkg exe as-is.
 *
 * Endpoints:
 *   GET /                    → dashboard HTML
 *   GET /api/stats           → overall counters
 *   GET /api/works           → paginated works list  ?page&q&sort&onSale
 *   GET /api/history/:rj     → price history array for charting
 *   GET /api/sales           → works currently on sale (sorted by discount)
 *   GET /api/export/json     → full price_history JSON download
 *   GET /api/export/csv      → full price_history CSV download
 */

const http   = require('http');
const url    = require('url');
const db     = require('./db');
const log    = require('./logger');
const config = require('../config');

// ─── API handlers ────────────────────────────────────────────────────────────

function handleStats() {
  return db.getStats();
}

function handleWorks(query) {
  const page   = Math.max(1, parseInt(query.page  ?? '1', 10));
  const q      = (query.q ?? '').trim();
  const sort   = query.sort ?? 'priority';
  const onSale = query.onSale === '1';
  return db.searchWorks({ q, sort, onSale, page });
}

function handleHistory(rjCode) {
  const history = db.getPriceHistory(rjCode);
  const work    = db.getWorkByRj(rjCode);
  return { work: work ?? null, history };
}

function handleSales() {
  return db.getSaleWorks(200);
}

function handleExportJson() {
  return db.exportAllHistory();
}

function handleExportCsv() {
  const data   = db.exportAllHistory();
  const header = 'rj_code,title,circle,price,sale_price,discount_rate,point,checked_at\n';
  const rows   = data.map(r =>
    [
      r.rj_code,
      _csvEscape(r.title),
      _csvEscape(r.circle),
      r.price         ?? '',
      r.sale_price    ?? '',
      r.discount_rate ?? '',
      r.point         ?? '',
      r.checked_at ? new Date(r.checked_at * 1000).toISOString() : '',
    ].join(',')
  );
  return header + rows.join('\n');
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

function createServer() {
  const server = http.createServer(async (req, res) => {
    const parsed   = url.parse(req.url ?? '/', true);
    const pathname = parsed.pathname ?? '/';
    const query    = parsed.query ?? {};

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    log.debug('[api]', req.method, pathname);

    try {
      // ── dashboard ─────────────────────────────────────────────────────
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      }

      // ── API routes ────────────────────────────────────────────────────
      if (pathname === '/api/stats') {
        return _json(res, handleStats());
      }

      if (pathname === '/api/works') {
        return _json(res, handleWorks(query));
      }

      const histMatch = pathname.match(/^\/api\/history\/(.+)$/);
      if (histMatch) {
        return _json(res, handleHistory(histMatch[1].toUpperCase()));
      }

      if (pathname === '/api/sales') {
        return _json(res, handleSales());
      }

      if (pathname === '/api/export/json') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="dlsite-history.json"',
        });
        res.end(JSON.stringify(handleExportJson(), null, 2));
        return;
      }

      if (pathname === '/api/export/csv') {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8-sig',
          'Content-Disposition': 'attachment; filename="dlsite-history.csv"',
        });
        res.end('\uFEFF' + handleExportCsv()); // BOM for Excel
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      log.error('[api] error', pathname, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return server;
}

function start() {
  const port = config.ui.port;
  const host = config.ui.host;
  const server = createServer();

  server.listen(port, host, () => {
    log.info(`[api] dashboard → http://${host}:${port}`);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      log.error(`[api] port ${port} in use – UI disabled`);
    } else {
      log.error('[api] server error', err.message);
    }
  });

  return server;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function _json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function _csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

// ─── embedded dashboard HTML ──────────────────────────────────────────────────

const DASHBOARD_HTML = /* html */`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DLsite Price Tracker</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=Noto+Sans+JP:wght@300;400;500&family=JetBrains+Mono:wght@400;600&display=swap');

  :root {
    --bg:       #080c14;
    --surface:  #0d1320;
    --card:     #111927;
    --border:   #1e2d45;
    --text:     #c8d6e8;
    --muted:    #4a607a;
    --accent:   #3b8ef3;
    --sale:     #f05454;
    --drop:     #22c893;
    --warn:     #f5a623;
    --mono:     'JetBrains Mono', monospace;
    --sans:     'Noto Sans JP', sans-serif;
    --display:  'Syne', sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 13px;
    height: 100vh;
    display: grid;
    grid-template-rows: 52px 1fr;
    grid-template-columns: 340px 1fr;
    overflow: hidden;
  }

  /* ── Header ── */
  header {
    grid-column: 1 / -1;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 0 20px;
  }
  .logo {
    font-family: var(--display);
    font-size: 17px;
    font-weight: 800;
    letter-spacing: -0.5px;
    color: #fff;
    white-space: nowrap;
  }
  .logo span { color: var(--accent); }

  .stats-bar {
    display: flex;
    gap: 20px;
    margin-left: auto;
  }
  .stat {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }
  .stat-val {
    font-family: var(--mono);
    font-size: 16px;
    font-weight: 600;
    color: #fff;
    line-height: 1;
  }
  .stat-val.sale  { color: var(--sale); }
  .stat-val.drop  { color: var(--drop); }
  .stat-lbl {
    font-size: 10px;
    color: var(--muted);
    letter-spacing: 0.05em;
    margin-top: 2px;
  }

  .export-btns {
    display: flex;
    gap: 6px;
    margin-left: 20px;
  }
  .btn {
    padding: 5px 12px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--text);
    font-size: 11px;
    cursor: pointer;
    font-family: var(--sans);
    transition: border-color .15s, color .15s;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }

  /* ── Left panel: works list ── */
  .panel-left {
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .search-box {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .search-box input {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 10px;
    color: var(--text);
    font-family: var(--sans);
    font-size: 12px;
    outline: none;
  }
  .search-box input:focus { border-color: var(--accent); }
  .search-box select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 6px;
    color: var(--text);
    font-size: 11px;
    cursor: pointer;
    outline: none;
  }
  .filter-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    flex: 1;
    padding: 7px 0;
    text-align: center;
    font-size: 11px;
    color: var(--muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color .15s;
  }
  .tab.active { color: var(--accent); border-color: var(--accent); }

  .works-list {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  .work-item {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background .1s;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 8px;
    align-items: start;
  }
  .work-item:hover { background: var(--card); }
  .work-item.active { background: rgba(59,142,243,.08); border-left: 2px solid var(--accent); padding-left: 12px; }

  .work-rj {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--muted);
  }
  .work-title {
    font-size: 12px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    grid-column: 1;
  }
  .work-circle {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .work-price-col {
    grid-row: 1 / 4;
    grid-column: 2;
    text-align: right;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
  }
  .price-tag {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    color: #fff;
  }
  .sale-tag {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--sale);
  }
  .discount-badge {
    display: inline-block;
    background: var(--sale);
    color: #fff;
    font-size: 10px;
    font-family: var(--mono);
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 3px;
  }

  .pagination {
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: center;
  }
  .page-btn { cursor: pointer; color: var(--muted); font-size: 12px; }
  .page-btn:hover { color: var(--accent); }
  .page-info { font-size: 11px; color: var(--muted); }

  /* ── Right panel: chart ── */
  .panel-right {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
  }

  .detail-header {
    padding: 16px 22px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .detail-rj {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    letter-spacing: .05em;
  }
  .detail-title {
    font-family: var(--display);
    font-size: 20px;
    font-weight: 700;
    color: #fff;
    margin: 2px 0 4px;
    line-height: 1.2;
  }
  .detail-meta {
    font-size: 12px;
    color: var(--muted);
  }
  .detail-badges {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    align-items: center;
  }
  .badge {
    padding: 3px 9px;
    border-radius: 99px;
    font-size: 11px;
    font-family: var(--mono);
    font-weight: 600;
  }
  .badge.on-sale { background: rgba(240,84,84,.15); color: var(--sale); border: 1px solid var(--sale); }
  .badge.normal  { background: rgba(59,142,243,.1);  color: var(--accent); border: 1px solid var(--accent); }
  .badge.discount { background: rgba(240,84,84,.2); color: #ff8080; border: 1px solid rgba(240,84,84,.4); }

  .chart-area {
    flex: 1;
    display: grid;
    grid-template-rows: 1fr 200px;
    gap: 0;
    overflow: hidden;
    padding: 16px;
    gap: 16px;
  }
  .chart-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .chart-label {
    font-size: 10px;
    letter-spacing: .12em;
    color: var(--muted);
    text-transform: uppercase;
    margin-bottom: 10px;
  }
  .chart-wrapper {
    flex: 1;
    position: relative;
    min-height: 0;
  }

  /* ── History table (bottom) ── */
  .history-table-wrap {
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
    max-height: 100%;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--card);
    padding: 6px 10px;
    text-align: left;
    font-size: 10px;
    letter-spacing: .08em;
    color: var(--muted);
    font-weight: 500;
    text-transform: uppercase;
    border-bottom: 1px solid var(--border);
    z-index: 1;
  }
  td {
    padding: 5px 10px;
    border-bottom: 1px solid rgba(30,45,69,.5);
    font-family: var(--mono);
    color: var(--text);
  }
  tr:hover td { background: rgba(59,142,243,.04); }
  td.sale-row { color: var(--sale); }
  td.date { color: var(--muted); font-size: 11px; }
  td.change-up { color: var(--sale); }
  td.change-down { color: var(--drop); }

  /* ── Empty / loading states ── */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--muted);
    gap: 8px;
  }
  .empty-icon { font-size: 40px; opacity: .3; }
  .empty-text { font-size: 13px; }

  .loading { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:1} }
</style>
</head>
<body>

<header>
  <div class="logo">DLsite <span>Tracker</span></div>
  <div class="stats-bar">
    <div class="stat">
      <div class="stat-val" id="st-total">–</div>
      <div class="stat-lbl">TRACKED</div>
    </div>
    <div class="stat">
      <div class="stat-val sale" id="st-sale">–</div>
      <div class="stat-lbl">ON SALE</div>
    </div>
    <div class="stat">
      <div class="stat-val drop" id="st-changes">–</div>
      <div class="stat-lbl">PRICE RECORDS</div>
    </div>
    <div class="stat">
      <div class="stat-val" id="st-due">–</div>
      <div class="stat-lbl">DUE CHECK</div>
    </div>
  </div>
  <div class="export-btns">
    <button class="btn" onclick="exportData('json')">↓ JSON</button>
    <button class="btn" onclick="exportData('csv')">↓ CSV</button>
  </div>
</header>

<div class="panel-left">
  <div class="search-box">
    <input id="search" type="text" placeholder="RJコード / タイトル / サークル..." oninput="onSearch()">
    <select id="sortSel" onchange="loadWorks(1)">
      <option value="priority">優先度</option>
      <option value="discount">割引率</option>
      <option value="price">価格</option>
      <option value="release">リリース</option>
      <option value="checked">確認日</option>
    </select>
  </div>
  <div class="filter-tabs">
    <div class="tab active" id="tab-all"    onclick="setTab('all')">全作品</div>
    <div class="tab"        id="tab-sale"   onclick="setTab('sale')">セール中</div>
  </div>
  <div class="works-list" id="worksList"></div>
  <div class="pagination" id="pagination"></div>
</div>

<div class="panel-right" id="panelRight">
  <div class="empty">
    <div class="empty-icon">📊</div>
    <div class="empty-text">作品を選択してください</div>
  </div>
</div>

<script>
// ── State ──────────────────────────────────────────────────────────────────
let _page   = 1;
let _tab    = 'all';
let _selRj  = null;
let _charts = {};
let _searchTimer = null;

// ── Boot ───────────────────────────────────────────────────────────────────
(async () => {
  await loadStats();
  await loadWorks(1);
  setInterval(loadStats, 30000);
})();

// ── Stats ──────────────────────────────────────────────────────────────────
async function loadStats() {
  const s = await api('/api/stats');
  if (!s) return;
  setText('st-total',   s.totalWorks);
  setText('st-sale',    s.onSale);
  setText('st-changes', s.priceChanges);
  setText('st-due',     s.dueNow);
}

// ── Works list ─────────────────────────────────────────────────────────────
async function loadWorks(page = 1) {
  _page = page;
  const q      = document.getElementById('search').value.trim();
  const sort   = document.getElementById('sortSel').value;
  const onSale = _tab === 'sale' ? '&onSale=1' : '';
  const data   = await api(\`/api/works?page=\${page}&q=\${encodeURIComponent(q)}&sort=\${sort}\${onSale}\`);
  if (!data) return;

  const el = document.getElementById('worksList');
  if (data.works.length === 0) {
    el.innerHTML = '<div class="empty" style="padding:40px"><div class="empty-icon">🔍</div><div class="empty-text">作品が見つかりません</div></div>';
  } else {
    el.innerHTML = data.works.map(w => workItemHTML(w)).join('');
  }

  renderPagination(data.page, data.pages);

  if (_selRj) {
    const el2 = document.querySelector(\`.work-item[data-rj="\${_selRj}"]\`);
    if (el2) el2.classList.add('active');
  }
}

function workItemHTML(w) {
  const priceStr = w.price != null ? '¥' + w.price.toLocaleString() : '–';
  const saleStr  = w.sale_price != null ? '¥' + w.sale_price.toLocaleString() : '';
  const disc     = w.discount_rate ? \`<span class="discount-badge">-\${w.discount_rate}%</span>\` : '';

  return \`
    <div class="work-item" data-rj="\${w.rj_code}" onclick="selectWork('\${w.rj_code}')">
      <div class="work-rj">\${w.rj_code}</div>
      <div class="work-price-col">
        <span class="price-tag">\${priceStr}</span>
        \${saleStr ? \`<span class="sale-tag">\${saleStr}</span>\` : ''}
        \${disc}
      </div>
      <div class="work-title">\${esc(w.title ?? '–')}</div>
      <div class="work-circle">\${esc(w.circle ?? '–')}</div>
    </div>
  \`;
}

function renderPagination(page, pages) {
  const el = document.getElementById('pagination');
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = \`
    <span class="page-btn" onclick="loadWorks(\${Math.max(1, page-1)})">◀</span>
    <span class="page-info">\${page} / \${pages}</span>
    <span class="page-btn" onclick="loadWorks(\${Math.min(pages, page+1)})">▶</span>
  \`;
}

// ── Detail panel ───────────────────────────────────────────────────────────
async function selectWork(rj) {
  document.querySelectorAll('.work-item').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(\`.work-item[data-rj="\${rj}"]\`);
  if (item) item.classList.add('active');

  _selRj = rj;
  const panel = document.getElementById('panelRight');
  panel.innerHTML = '<div class="empty loading"><div class="empty-icon">⏳</div><div class="empty-text">読み込み中...</div></div>';

  const data = await api(\`/api/history/\${rj}\`);
  if (!data) return;

  const { work, history } = data;
  renderDetail(work, history, rj, panel);
}

function renderDetail(work, history, rj, panel) {
  const title   = work?.title    ?? rj;
  const circle  = work?.circle   ?? '–';
  const isOnSale = work?.is_on_sale;
  const latest  = history.length ? history[history.length - 1] : null;

  const badgesHTML = [
    isOnSale ? '<span class="badge on-sale">SALE</span>' : '<span class="badge normal">NORMAL</span>',
    latest?.discount_rate ? \`<span class="badge discount">-\${latest.discount_rate}%</span>\` : '',
    latest?.price != null ? \`<span style="font-family:var(--mono);font-size:14px;color:#fff">¥\${latest.price.toLocaleString()}</span>\` : '',
    latest?.sale_price != null ? \`<span style="font-family:var(--mono);font-size:14px;color:var(--sale)">→ ¥\${latest.sale_price.toLocaleString()}</span>\` : '',
  ].filter(Boolean).join('');

  panel.innerHTML = \`
    <div class="detail-header">
      <div class="detail-rj">\${rj} · \${work?.work_type ?? ''} · \${work?.release_date ?? ''}</div>
      <div class="detail-title">\${esc(title)}</div>
      <div class="detail-meta">\${esc(circle)}</div>
      <div class="detail-badges">\${badgesHTML}</div>
    </div>
    <div class="chart-area">
      <div class="chart-card">
        <div class="chart-label">価格推移 (JPY)</div>
        <div class="chart-wrapper"><canvas id="priceChart"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-label">割引率推移 (%)</div>
        <div class="chart-wrapper" style="height:130px">
          <canvas id="discChart"></canvas>
        </div>
        <div class="history-table-wrap" style="margin-top:8px;max-height:none;overflow:visible">
          \${historyTableHTML(history)}
        </div>
      </div>
    </div>
  \`;

  destroyCharts();
  renderCharts(history);
}

function historyTableHTML(history) {
  if (!history.length) return '<div style="color:var(--muted);padding:8px;text-align:center;font-size:12px">履歴なし</div>';
  const rows = [...history].reverse().map((h, i, arr) => {
    const prev   = arr[i + 1];
    const date   = h.checked_at ? new Date(h.checked_at * 1000) : null;
    const dateStr = date ? date.toLocaleDateString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '–';

    let changeClass = '';
    if (prev && h.price != null && prev.price != null) {
      if (h.price < prev.price) changeClass = 'change-down';
      else if (h.price > prev.price) changeClass = 'change-up';
    }
    const priceStr = h.price != null ? '¥' + h.price.toLocaleString() : '–';
    const saleStr  = h.sale_price != null ? '¥' + h.sale_price.toLocaleString() : '–';
    const discStr  = h.discount_rate != null ? h.discount_rate + '%' : '–';

    return \`<tr>
      <td class="date">\${dateStr}</td>
      <td class="\${changeClass}">\${priceStr}</td>
      <td class="\${h.sale_price ? 'sale-row' : ''}">\${saleStr}</td>
      <td class="\${h.discount_rate ? 'sale-row' : ''}">\${discStr}</td>
    </tr>\`;
  }).join('');

  return \`<table>
    <thead><tr>
      <th>日付</th><th>定価</th><th>セール価格</th><th>割引率</th>
    </tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

// ── Charts ─────────────────────────────────────────────────────────────────
function renderCharts(history) {
  const labels  = history.map(h => {
    const d = h.checked_at ? new Date(h.checked_at * 1000) : null;
    return d ? d.toLocaleDateString('ja-JP', { month:'2-digit', day:'2-digit' }) : '';
  });

  const prices     = history.map(h => h.price      ?? null);
  const salePrices = history.map(h => h.sale_price  ?? null);
  const discounts  = history.map(h => h.discount_rate ?? null);

  const gridColor   = 'rgba(30,45,69,0.7)';
  const tickColor   = '#4a607a';
  const baseOpts    = {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: { legend: { labels: { color: '#c8d6e8', font: { size: 11 } } } },
    scales: {
      x: { grid: { color: gridColor }, ticks: { color: tickColor, maxTicksLimit: 8 } },
    },
  };

  // Price chart
  const pc = document.getElementById('priceChart');
  if (pc) {
    _charts.price = new Chart(pc, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '定価',
            data: prices,
            borderColor: '#3b8ef3',
            backgroundColor: 'rgba(59,142,243,.08)',
            fill: true,
            tension: 0.3,
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#3b8ef3',
            spanGaps: true,
          },
          {
            label: 'セール価格',
            data: salePrices,
            borderColor: '#f05454',
            backgroundColor: 'rgba(240,84,84,.08)',
            fill: false,
            tension: 0.3,
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#f05454',
            spanGaps: true,
          },
        ],
      },
      options: {
        ...baseOpts,
        scales: {
          ...baseOpts.scales,
          y: {
            grid: { color: gridColor },
            ticks: { color: tickColor, callback: v => '¥' + v.toLocaleString() },
          },
        },
      },
    });
  }

  // Discount chart
  const dc = document.getElementById('discChart');
  if (dc) {
    _charts.disc = new Chart(dc, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '割引率',
          data: discounts,
          backgroundColor: discounts.map(v =>
            v == null ? 'transparent' : v >= 50 ? 'rgba(240,84,84,.7)' : 'rgba(245,166,35,.6)'
          ),
          borderRadius: 3,
          spanGaps: true,
        }],
      },
      options: {
        ...baseOpts,
        plugins: { legend: { display: false } },
        scales: {
          ...baseOpts.scales,
          y: {
            grid: { color: gridColor },
            ticks: { color: tickColor, callback: v => v + '%' },
            max: 100, min: 0,
          },
        },
      },
    });
  }
}

function destroyCharts() {
  Object.values(_charts).forEach(c => c?.destroy());
  _charts = {};
}

// ── Controls ───────────────────────────────────────────────────────────────
function setTab(tab) {
  _tab = tab;
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  loadWorks(1);
}

function onSearch() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => loadWorks(1), 300);
}

function exportData(fmt) {
  window.open('/api/export/' + fmt, '_blank');
}

// ── Utils ──────────────────────────────────────────────────────────────────
async function api(path) {
  try {
    const r = await fetch(path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch(e) {
    console.error('[api]', path, e.message);
    return null;
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val != null ? val.toLocaleString() : '–';
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
</script>
</body>
</html>`;

module.exports = { start, createServer };
