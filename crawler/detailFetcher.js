'use strict';

/**
 * crawler/detailFetcher.js
 * Fetches full detail + price for individual RJ codes.
 *
 * Uses DLsite's product/info/ajax endpoint (JSON) – more stable than HTML scraping.
 *
 * Circle-sale propagation:
 *   If a work's discount_rate increases significantly compared to the last
 *   known state, the entire circle is flagged and all its works are
 *   boosted to high-priority short-interval checks.
 */

const config = require('../config');
const db     = require('./db');
const parser = require('./parser');
const log    = require('./logger');
const { fetchWithRetry, sleep } = require('./queue');

const BASE = config.dlsite.baseUrl;

// ─── batch fetch ─────────────────────────────────────────────────────────────

/**
 * Process up to `limit` due works from the DB.
 * @param {number} limit
 * @returns {{ processed: number, priceChanges: number, errors: number }}
 */
async function runDetailFetch(limit = 30) {
  const due = db.getDueWorks(limit);
  log.info('[detailFetcher] due works', due.length);

  const result = { processed: 0, priceChanges: 0, errors: 0 };

  for (const work of due) {
    try {
      const changed = await fetchAndStore(work.rj_code, work.site_id ?? 'maniax');
      result.processed++;
      if (changed) result.priceChanges++;
    } catch (err) {
      result.errors++;
      log.error('[detailFetcher] error on', work.rj_code, err.message);
    }

    // rate limit between individual requests
    await sleep(config.fetch.rateLimit);
  }

  log.info('[detailFetcher] done', result);
  return result;
}

// ─── single work fetch ───────────────────────────────────────────────────────

/**
 * Fetch detail for one RJ code, store if price changed.
 * @returns {boolean} true if price changed
 */
async function fetchAndStore(rjCode, siteId = 'maniax') {
  const url = `${BASE}/${siteId}/product/info/ajax?product_id=${rjCode}&cdn_cache_min=1`;

  let body;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Accept: 'application/json, text/javascript, */*' },
    });

    if (!res.ok) {
      log.warn('[detailFetcher] non-200', res.status, rjCode);
      _markCheckedNoChange(rjCode);
      return false;
    }

    body = await res.json();
  } catch (err) {
    log.error('[detailFetcher] fetch failed', rjCode, err.message);
    // still update last_checked so we don't hammer a failing work
    _markCheckedNoChange(rjCode);
    return false;
  }

  const parsed = parser.parseProductInfo(rjCode, body);
  if (!parsed) {
    log.warn('[detailFetcher] parse failed', rjCode);
    _markCheckedNoChange(rjCode);
    return false;
  }

  const { work, price } = parsed;

  // upsert full work metadata
  db.upsertWork(work);

  // maintain circles table + circle-sale propagation
  if (work.maker_id && work.circle) {
    db.upsertCircle(work.maker_id, work.circle);
    await _propagateCircleSale(rjCode, work.maker_id, price);
  }

  // diff-only price save
  const priceChanged = db.savePriceIfChanged(rjCode, price);

  // calculate next check parameters
  const existing = db.getWorkByRj(rjCode);
  const noChangeCount = priceChanged
    ? 0
    : (existing?.consecutive_no_change ?? 0) + 1;

  const { interval, priority } = _calcSchedule(work, price, noChangeCount);

  db.markChecked(rjCode, {
    check_interval:        interval,
    priority:              priority,
    is_on_sale:            price.is_on_sale,
    consecutive_no_change: noChangeCount,
  });

  if (priceChanged) {
    log.info('[detailFetcher] price changed', {
      rj: rjCode,
      price: price.price,
      sale_price: price.sale_price,
      discount: price.discount_rate,
    });
  } else {
    log.debug('[detailFetcher] no change', rjCode);
  }

  return priceChanged;
}

// ─── circle-sale propagation ─────────────────────────────────────────────────

/**
 * Key insight from user:
 *   "サークルの商品は値下げをしたら、サークル全体が値下げすると思う"
 *   (If one work in a circle goes on sale, the whole circle likely does too)
 *
 * If this work is on sale AND the circle was NOT previously marked on-sale:
 *   1. Mark the circle as on-sale
 *   2. Boost ALL works from this circle to high priority + short interval
 *
 * If the work is no longer on sale AND no other works from the circle are on sale:
 *   1. Clear circle on-sale flag
 *   2. Works will naturally cool off after their next check
 */
async function _propagateCircleSale(rjCode, makerId, price) {
  const circle = db.getCircle(makerId);
  if (!circle) return;

  const isNowOnSale     = price.is_on_sale === 1;
  const wasCircleOnSale = circle.on_sale === 1;

  if (isNowOnSale && !wasCircleOnSale) {
    log.info('[detailFetcher] circle sale detected – boosting all works', makerId);
    db.markCircleOnSale(makerId, true);
    db.boostCircleWorks(
      makerId,
      config.priority.circleOnSale,
      config.checkInterval.onSale
    );
  } else if (!isNowOnSale && wasCircleOnSale) {
    // One work ended sale; we don't immediately clear the circle flag –
    // let the next full check pass resolve it naturally.
    // (Other works may still be on sale.)
    log.debug('[detailFetcher] work off-sale, circle flag kept until next pass', makerId);
  }
}

// ─── scheduling ──────────────────────────────────────────────────────────────

/**
 * Determine check_interval and priority based on work state.
 * Lower consecutive_no_change = more frequent checks.
 */
function _calcSchedule(work, price, noChangeCount) {
  const ci   = config.checkInterval;
  const prio = config.priority;

  if (price.is_on_sale) {
    return { interval: ci.onSale, priority: prio.onSale };
  }

  if (noChangeCount >= 5) {
    return { interval: ci.cold, priority: prio.cold };
  }

  if (work.release_date) {
    const ageDays = _ageDays(work.release_date);
    if (ageDays < 7) {
      return { interval: ci.newWork, priority: prio.newWork };
    }
    if (ageDays < 30) {
      return { interval: ci.recentWork, priority: prio.recentWork };
    }
  }

  if ((work.dl_count ?? 0) >= 1000) {
    return { interval: ci.popular, priority: prio.popular };
  }

  return { interval: ci.normal, priority: prio.normal };
}

function _ageDays(releaseDateStr) {
  if (!releaseDateStr) return 9999;
  try {
    const d    = new Date(releaseDateStr);
    const diff = Date.now() - d.getTime();
    return Math.floor(diff / (86400 * 1000));
  } catch {
    return 9999;
  }
}

function _markCheckedNoChange(rjCode) {
  const existing = db.getWorkByRj(rjCode);
  if (!existing) return;

  const noChange = (existing.consecutive_no_change ?? 0) + 1;
  const { interval, priority } = _calcSchedule(
    existing,
    { is_on_sale: existing.is_on_sale },
    noChange
  );

  db.markChecked(rjCode, {
    check_interval:        interval,
    priority:              priority,
    is_on_sale:            existing.is_on_sale ?? 0,
    consecutive_no_change: noChange,
  });
}

module.exports = { runDetailFetch, fetchAndStore };
