'use strict';

/**
 * crawler/db.js
 * SQLite access layer.
 * All schema migrations are forward-only (no drop/rename).
 */

const Database = require('better-sqlite3');
const config   = require('../config');
const log      = require('./logger');

let _db = null;

// ─── open / init ────────────────────────────────────────────────────────────

function open() {
  if (_db) return _db;

  _db = new Database(config.db.path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  _applySchema();
  log.info('[db] opened', config.db.path);
  return _db;
}

function _applySchema() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS works (
      rj_code              TEXT    PRIMARY KEY,
      title                TEXT,
      circle               TEXT,
      maker_id             TEXT,
      work_type            TEXT,
      site_id              TEXT    DEFAULT 'maniax',
      release_date         TEXT,
      dl_count             INTEGER DEFAULT 0,
      first_seen           INTEGER NOT NULL,
      last_checked         INTEGER DEFAULT 0,
      check_interval       INTEGER DEFAULT 86400,
      priority             INTEGER DEFAULT 20,
      is_on_sale           INTEGER DEFAULT 0,
      consecutive_no_change INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rj_code       TEXT    NOT NULL,
      price         INTEGER,
      sale_price    INTEGER,
      point         INTEGER,
      discount_rate INTEGER,
      checked_at    INTEGER NOT NULL,
      FOREIGN KEY (rj_code) REFERENCES works(rj_code)
    );

    CREATE TABLE IF NOT EXISTS circles (
      maker_id          TEXT PRIMARY KEY,
      circle_name       TEXT,
      on_sale           INTEGER DEFAULT 0,
      sale_detected_at  INTEGER,
      works_count       INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_ph_rj      ON price_history(rj_code);
    CREATE INDEX IF NOT EXISTS idx_ph_at      ON price_history(checked_at);
    CREATE INDEX IF NOT EXISTS idx_works_maker ON works(maker_id);
    CREATE INDEX IF NOT EXISTS idx_works_due
      ON works(last_checked, check_interval)
      WHERE last_checked IS NOT NULL;
  `);
}

// ─── works ──────────────────────────────────────────────────────────────────

/**
 * Upsert a work row. Does NOT overwrite last_checked / priority if already set.
 * @param {object} w  { rj_code, title, circle, maker_id, work_type, site_id,
 *                      release_date, dl_count }
 */
function upsertWork(w) {
  const db  = open();
  const now = unixNow();

  db.prepare(`
    INSERT INTO works
      (rj_code, title, circle, maker_id, work_type, site_id,
       release_date, dl_count, first_seen)
    VALUES
      (@rj_code, @title, @circle, @maker_id, @work_type, @site_id,
       @release_date, @dl_count, @now)
    ON CONFLICT(rj_code) DO UPDATE SET
      title        = excluded.title,
      circle       = excluded.circle,
      maker_id     = excluded.maker_id,
      work_type    = excluded.work_type,
      site_id      = excluded.site_id,
      release_date = excluded.release_date,
      dl_count     = COALESCE(excluded.dl_count, works.dl_count)
  `).run({ ...w, now });
}

/**
 * Update fields set by the detail fetcher after a successful fetch.
 */
function markChecked(rjCode, fields) {
  const db = open();
  db.prepare(`
    UPDATE works SET
      last_checked          = @now,
      check_interval        = @check_interval,
      priority              = @priority,
      is_on_sale            = @is_on_sale,
      consecutive_no_change = @consecutive_no_change
    WHERE rj_code = @rj_code
  `).run({ rj_code: rjCode, now: unixNow(), ...fields });
}

/**
 * Returns works whose next check time has passed.
 * next_check = last_checked + check_interval
 */
function getDueWorks(limit = 50) {
  const db  = open();
  const now = unixNow();
  return db.prepare(`
    SELECT * FROM works
    WHERE (last_checked + check_interval) <= @now
    ORDER BY priority DESC, (last_checked + check_interval) ASC
    LIMIT @limit
  `).all({ now, limit });
}

function getWorkByRj(rjCode) {
  return open().prepare('SELECT * FROM works WHERE rj_code = ?').get(rjCode);
}

function getAllMakerIds() {
  return open()
    .prepare('SELECT DISTINCT maker_id FROM works WHERE maker_id IS NOT NULL')
    .all()
    .map(r => r.maker_id);
}

/** Boost priority of all works belonging to a circle */
function boostCircleWorks(makerId, priority, checkInterval) {
  const db = open();
  db.prepare(`
    UPDATE works
    SET priority = @priority,
        check_interval = @checkInterval,
        is_on_sale = 1
    WHERE maker_id = @makerId
  `).run({ makerId, priority, checkInterval });
}

// ─── price_history ──────────────────────────────────────────────────────────

/** Returns the most recent price_history row for an RJ code, or null. */
function getLatestPrice(rjCode) {
  return open().prepare(`
    SELECT * FROM price_history
    WHERE rj_code = ?
    ORDER BY checked_at DESC
    LIMIT 1
  `).get(rjCode);
}

/**
 * Insert a price row only when the price has changed vs the last record.
 * Returns true if a row was inserted (price changed).
 */
function savePriceIfChanged(rjCode, priceData) {
  const last = getLatestPrice(rjCode);

  const changed =
    !last ||
    last.price         !== priceData.price         ||
    last.sale_price    !== priceData.sale_price    ||
    last.discount_rate !== priceData.discount_rate ||
    last.point         !== priceData.point;

  if (!changed) return false;

  open().prepare(`
    INSERT INTO price_history
      (rj_code, price, sale_price, point, discount_rate, checked_at)
    VALUES
      (@rj_code, @price, @sale_price, @point, @discount_rate, @checked_at)
  `).run({
    rj_code:       rjCode,
    price:         priceData.price         ?? null,
    sale_price:    priceData.sale_price    ?? null,
    point:         priceData.point         ?? null,
    discount_rate: priceData.discount_rate ?? null,
    checked_at:    unixNow(),
  });

  return true;
}

function getPriceHistory(rjCode) {
  return open().prepare(`
    SELECT * FROM price_history WHERE rj_code = ? ORDER BY checked_at ASC
  `).all(rjCode);
}

// ─── circles ────────────────────────────────────────────────────────────────

function upsertCircle(makerId, circleName) {
  open().prepare(`
    INSERT INTO circles (maker_id, circle_name, works_count)
    VALUES (@makerId, @circleName, 1)
    ON CONFLICT(maker_id) DO UPDATE SET
      circle_name  = excluded.circle_name,
      works_count  = works_count + 1
  `).run({ makerId, circleName });
}

function markCircleOnSale(makerId, onSale) {
  open().prepare(`
    UPDATE circles
    SET on_sale = @onSale,
        sale_detected_at = CASE WHEN @onSale = 1 THEN @now ELSE sale_detected_at END
    WHERE maker_id = @makerId
  `).run({ makerId, onSale: onSale ? 1 : 0, now: unixNow() });
}

function getCircle(makerId) {
  return open().prepare('SELECT * FROM circles WHERE maker_id = ?').get(makerId);
}

// ─── stats ──────────────────────────────────────────────────────────────────

function getStats() {
  const db = open();
  return {
    totalWorks:    db.prepare('SELECT COUNT(*) AS n FROM works').get().n,
    onSale:        db.prepare('SELECT COUNT(*) AS n FROM works WHERE is_on_sale = 1').get().n,
    priceChanges:  db.prepare('SELECT COUNT(*) AS n FROM price_history').get().n,
    circlesOnSale: db.prepare('SELECT COUNT(*) AS n FROM circles WHERE on_sale = 1').get().n,
    dueNow:        getDueWorks(9999).length,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
    log.info('[db] closed');
  }
}

module.exports = {
  open,
  close,
  upsertWork,
  markChecked,
  getDueWorks,
  getWorkByRj,
  getAllMakerIds,
  boostCircleWorks,
  getLatestPrice,
  savePriceIfChanged,
  getPriceHistory,
  upsertCircle,
  markCircleOnSale,
  getCircle,
  getStats,
  unixNow,
};
