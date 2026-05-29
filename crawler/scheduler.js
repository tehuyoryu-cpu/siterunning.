'use strict';

/**
 * crawler/scheduler.js
 * Orchestrates discovery + detail fetch using node-cron.
 *
 * Schedule:
 *   Every 6h  – discovery pass (find new RJ codes)
 *   Every 20m – detail pass (flush due-work queue)
 *   Every 10m – sale-boost pass (re-prioritise works in on-sale circles)
 *
 * Guards:
 *   - Only one job of each type runs at a time
 *   - Errors are caught and logged; scheduler never crashes
 */

const cron   = require('node-cron');
const config = require('../config');
const db     = require('./db');
const log    = require('./logger');
const { runDiscovery }   = require('./discovery');
const { runDetailFetch } = require('./detailFetcher');
const { runNewsCrawl }   = require('./newsCrawler');
const newsDb             = require('./newsDb');

// Lock flags prevent overlapping runs of the same job type
const _running = {
  discovery: false,
  detail:    false,
  saleBoost: false,
  news:      false,
};

// ─── discovery job ───────────────────────────────────────────────────────────

function _startDiscoveryJob() {
  cron.schedule(config.cron.discovery, async () => {
    if (_running.discovery) {
      log.warn('[scheduler] discovery still running, skip');
      return;
    }
    _running.discovery = true;
    try {
      await runDiscovery();
    } catch (err) {
      log.error('[scheduler] discovery error', err.message);
    } finally {
      _running.discovery = false;
    }
  });
  log.info('[scheduler] discovery job scheduled', config.cron.discovery);
}

// ─── detail fetch job ────────────────────────────────────────────────────────

function _startDetailJob() {
  cron.schedule(config.cron.detail, async () => {
    if (_running.detail) {
      log.warn('[scheduler] detail still running, skip');
      return;
    }
    _running.detail = true;
    try {
      await runDetailFetch(30); // 30 works per pass
    } catch (err) {
      log.error('[scheduler] detail error', err.message);
    } finally {
      _running.detail = false;
    }
  });
  log.info('[scheduler] detail job scheduled', config.cron.detail);
}

// ─── sale-boost job ──────────────────────────────────────────────────────────

/**
 * Re-apply circle sale boost every 10 min.
 * If a circle is still flagged on_sale in the DB, ensure all its works
 * have a short check interval. This handles restarts and new works added mid-sale.
 */
function _startSaleBoostJob() {
  cron.schedule(config.cron.saleBoost, () => {
    if (_running.saleBoost) return;
    _running.saleBoost = true;

    try {
      const onSaleCircles = db.getCirclesOnSale();  // ① sql.js対応ヘルパー使用

      db.transaction(() => {
        for (const { maker_id } of onSaleCircles) {
          db.boostCircleWorks(
            maker_id,
            config.priority.circleOnSale,
            config.checkInterval.onSale
          );
        }
      });

      if (onSaleCircles.length > 0) {
        log.debug('[scheduler] re-boosted', onSaleCircles.length, 'circles');
      }
    } catch (err) {
      log.error('[scheduler] saleBoost error', err.message);
    } finally {
      _running.saleBoost = false;
    }
  });
  log.info('[scheduler] saleBoost job scheduled', config.cron.saleBoost);
}

// ─── daily backup job ────────────────────────────────────────────────────────

// ─── news crawl job ──────────────────────────────────────────────────────────

function _startNewsJob() {
  // ニュースは1時間ごとにクロール
  cron.schedule('0 * * * *', async () => {
    if (_running.news) {
      log.warn('[scheduler] news crawl still running, skip');
      return;
    }
    _running.news = true;
    try {
      await runNewsCrawl({ maxPerSource: 10, translateAll: true });
    } catch (err) {
      log.error('[scheduler] news error', err.message);
    } finally {
      _running.news = false;
    }
  });
  log.info('[scheduler] news job scheduled (every 1h)');
}

function _startBackupJob() {
  cron.schedule('0 3 * * *', () => {
    try {
      db.backup();
      db.syncCircleWorksCounts();  // ⑥ works_count を正確な値に同期
    }
    catch (err) { log.error('[scheduler] backup error', err.message); }
  });
  log.info('[scheduler] backup job scheduled (daily 03:00)');
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Start all cron jobs. Call once at process start.
 * Also runs an immediate discovery+detail pass on startup.
 */
async function start() {
  log.info('[scheduler] starting');

  _startDiscoveryJob();
  _startDetailJob();
  _startSaleBoostJob();
  _startBackupJob();
  _startNewsJob();

  // Initial run on startup (don't wait for cron trigger)
  log.info('[scheduler] running initial passes on startup');

  // ニュースDBを初期化して初回クロール
  newsDb.init().then(() => {
    _running.news = true;
    runNewsCrawl({ maxPerSource: 5, translateAll: true })
      .catch(err => log.error('[scheduler] initial news error', err.message))
      .finally(() => { _running.news = false; });
  }).catch(err => log.error('[scheduler] newsDb init error', err.message));

  _running.discovery = true;
  runDiscovery()
    .catch(err => log.error('[scheduler] initial discovery error', err.message))
    .finally(() => { _running.discovery = false; });

  // Small delay then start detail pass so discovery has a head start
  setTimeout(() => {
    _running.detail = true;
    runDetailFetch(50)
      .catch(err => log.error('[scheduler] initial detail error', err.message))
      .finally(() => { _running.detail = false; });
  }, 5000);
}

function stop() {
  log.info('[scheduler] stopping (cron tasks will finish current tick)');
  // node-cron doesn't expose a global stop; process.exit() handles cleanup
}

module.exports = { start, stop };
