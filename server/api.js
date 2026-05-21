'use strict';

/**
 * server/api.js
 * Express REST API for the UI.
 * Reads directly from db.js — no separate DB connection.
 */

const express = require('express');
const path    = require('path');
const db      = require('../crawler/db');
const log     = require('../crawler/logger');

const router = express.Router();

// ── works list ───────────────────────────────────────────────────────────────

// GET /api/works?q=&sale=&sort=price_changed
router.get('/works', (req, res) => {
  try {
    const { q = '', sale, sort = 'last_checked' } = req.query;
    const dbInst = db.open();

    let sql = `
      SELECT
        w.rj_code, w.title, w.circle, w.maker_id,
        w.release_date, w.is_on_sale, w.last_checked,
        p.price, p.sale_price, p.discount_rate, p.checked_at AS price_at
      FROM works w
      LEFT JOIN (
        SELECT rj_code, price, sale_price, discount_rate, checked_at
        FROM price_history
        WHERE id IN (
          SELECT MAX(id) FROM price_history GROUP BY rj_code
        )
      ) p ON w.rj_code = p.rj_code
      WHERE 1=1
    `;
    const params = [];

    if (q) {
      sql += ` AND (w.rj_code LIKE ? OR w.title LIKE ? OR w.circle LIKE ?)`;
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (sale === '1') {
      sql += ` AND w.is_on_sale = 1`;
    }

    const orderMap = {
      last_checked:    'w.last_checked DESC',
      price_changed:   'p.checked_at DESC',
      discount:        'p.discount_rate DESC',
      circle:          'w.circle ASC',
      release:         'w.release_date DESC',
    };
    sql += ` ORDER BY ${orderMap[sort] ?? orderMap.last_checked}`;
    sql += ` LIMIT 500`;

    const rows = dbInst.prepare(sql).all(...params);
    res.json({ ok: true, works: rows });
  } catch (err) {
    log.error('[api] GET /works', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── work detail + full price history ─────────────────────────────────────────

// GET /api/works/:rj
router.get('/works/:rj', (req, res) => {
  try {
    const rj   = req.params.rj.toUpperCase();
    const work = db.getWorkByRj(rj);
    if (!work) return res.status(404).json({ ok: false, error: 'not found' });

    const history = db.getPriceHistory(rj);
    res.json({ ok: true, work, history });
  } catch (err) {
    log.error('[api] GET /works/:rj', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── global stats ─────────────────────────────────────────────────────────────

// GET /api/stats
router.get('/stats', (req, res) => {
  try {
    res.json({ ok: true, stats: db.getStats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── currently on sale ────────────────────────────────────────────────────────

// GET /api/sales
router.get('/sales', (req, res) => {
  try {
    const dbInst = db.open();
    const rows = dbInst.prepare(`
      SELECT
        w.rj_code, w.title, w.circle,
        p.price, p.sale_price, p.discount_rate, p.checked_at
      FROM works w
      JOIN (
        SELECT rj_code, price, sale_price, discount_rate, checked_at
        FROM price_history
        WHERE id IN (SELECT MAX(id) FROM price_history GROUP BY rj_code)
      ) p ON w.rj_code = p.rj_code
      WHERE w.is_on_sale = 1
      ORDER BY p.discount_rate DESC
    `).all();
    res.json({ ok: true, sales: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── circles on sale ──────────────────────────────────────────────────────────

// GET /api/circles/sale
router.get('/circles/sale', (req, res) => {
  try {
    const dbInst = db.open();
    const rows = dbInst.prepare(`
      SELECT c.*, COUNT(w.rj_code) AS works_on_sale
      FROM circles c
      LEFT JOIN works w ON c.maker_id = w.maker_id AND w.is_on_sale = 1
      WHERE c.on_sale = 1
      GROUP BY c.maker_id
      ORDER BY c.sale_detected_at DESC
    `).all();
    res.json({ ok: true, circles: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── price history for chart ──────────────────────────────────────────────────

// GET /api/works/:rj/chart
// Returns price/discount/date arrays suitable for Chart.js
router.get('/works/:rj/chart', (req, res) => {
  try {
    const rj      = req.params.rj.toUpperCase();
    const history = db.getPriceHistory(rj);

    const labels        = [];
    const prices        = [];
    const salePrices    = [];
    const discountRates = [];

    for (const h of history) {
      labels.push(new Date(h.checked_at * 1000).toISOString());
      prices.push(h.price);
      salePrices.push(h.sale_price ?? null);
      discountRates.push(h.discount_rate ?? 0);
    }

    res.json({ ok: true, rj, labels, prices, salePrices, discountRates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── export: single work CSV ──────────────────────────────────────────────────

// GET /api/works/:rj/export.csv
router.get('/works/:rj/export.csv', (req, res) => {
  try {
    const rj      = req.params.rj.toUpperCase();
    const work    = db.getWorkByRj(rj);
    if (!work) return res.status(404).send('not found');

    const history = db.getPriceHistory(rj);
    const lines   = [
      'rj_code,title,circle,date,price,sale_price,discount_rate,point',
      ...history.map(h => [
        rj,
        _csvEsc(work.title),
        _csvEsc(work.circle),
        new Date(h.checked_at * 1000).toISOString(),
        h.price      ?? '',
        h.sale_price ?? '',
        h.discount_rate ?? '',
        h.point      ?? '',
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${rj}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n')); // BOM for Excel
  } catch (err) {
    log.error('[api] export csv', err.message);
    res.status(500).send(err.message);
  }
});

// GET /api/export/all.csv  – full price history dump
router.get('/export/all.csv', (req, res) => {
  try {
    const rows  = db.exportAllHistory();
    const lines = [
      'rj_code,title,circle,maker_id,work_type,release_date,date,price,sale_price,discount_rate,point',
      ...rows.map(h => [
        h.rj_code,
        _csvEsc(h.title),
        _csvEsc(h.circle),
        _csvEsc(h.maker_id),
        h.work_type    ?? '',
        h.release_date ?? '',
        new Date(h.checked_at * 1000).toISOString(),
        h.price         ?? '',
        h.sale_price    ?? '',
        h.discount_rate ?? '',
        h.point         ?? '',
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="dlsite-all.csv"');
    res.send('\uFEFF' + lines.join('\r\n'));
  } catch (err) {
    log.error('[api] export all csv', err.message);
    res.status(500).send(err.message);
  }
});

// GET /api/export/all.json
router.get('/export/all.json', (req, res) => {
  try {
    const rows = db.exportAllHistory();
    res.setHeader('Content-Disposition', 'attachment; filename="dlsite-all.json"');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function _csvEsc(v) {
  if (v == null) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

// ── server factory ───────────────────────────────────────────────────────────

function createServer(port = 3000) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use(express.static(path.join(__dirname, 'public')));

  // SPA fallback (Express 5 compatible)
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => {
      log.info(`[server] UI running at http://127.0.0.1:${port}`);
      resolve(srv);
    });
    srv.on('error', reject);
  });
}

module.exports = { createServer };
