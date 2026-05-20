'use strict';

/**
 * crawler/discovery.js
 * Discovers RJ codes from DLsite's public listing pages.
 *
 * Sources:
 *   1. New releases (per site: maniax, home)
 *   2. Monthly ranking
 *   3. Sale / campaign page
 *   4. Circle pages (for known circles – propagates circle sale detection)
 *
 * All discovered codes are upserted into the DB so detail fetcher can pick them up.
 */

const config = require('../config');
const db     = require('./db');
const parser = require('./parser');
const log    = require('./logger');
const { fetchWithRetry, sleep } = require('./queue');

const BASE = config.dlsite.baseUrl;

// ─── main entry ─────────────────────────────────────────────────────────────

/**
 * Run a full discovery pass.
 * @returns {{ discovered: number, sources: object }}
 */
async function runDiscovery() {
  log.info('[discovery] start');
  const summary = { new: 0, ranking: 0, sale: 0, circle: 0 };

  for (const site of config.dlsite.sites) {
    summary.new     += await _discoverNew(site);
    summary.ranking += await _discoverRanking(site);
    summary.sale    += await _discoverSale(site);
  }

  summary.circle = await _discoverFromKnownCircles();

  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  log.info('[discovery] done', { total, ...summary });
  return { discovered: total, sources: summary };
}

// ─── source: new releases ────────────────────────────────────────────────────

async function _discoverNew(site) {
  let count = 0;
  const pages = config.dlsite.discoveryPages.new;

  for (let page = 1; page <= pages; page++) {
    const url = `${BASE}/${site}/new/=/per_page/100/page/${page}.html`;
    const codes = await _fetchAndParse(url, parser.parseWorkList, site);
    count += _upsertDiscovered(codes, site);

    if (codes.length === 0) break; // no more pages
    await sleep(config.fetch.rateLimit);
  }

  log.debug('[discovery] new releases', site, count);
  return count;
}

// ─── source: ranking ────────────────────────────────────────────────────────

async function _discoverRanking(site) {
  let count = 0;
  const pages = config.dlsite.discoveryPages.ranking;
  const terms = ['day', 'week', 'month'];

  for (const term of terms) {
    for (let page = 1; page <= pages; page++) {
      const url   = `${BASE}/${site}/ranking/=/term/${term}/page/${page}.html`;
      const codes = await _fetchAndParse(url, parser.parseRankingList, site);
      count += _upsertDiscovered(codes, site);

      if (codes.length === 0) break;
      await sleep(config.fetch.rateLimit);
    }
  }

  log.debug('[discovery] ranking', site, count);
  return count;
}

// ─── source: sale / campaign ─────────────────────────────────────────────────

async function _discoverSale(site) {
  let count = 0;
  const pages = config.dlsite.discoveryPages.sale;

  for (let page = 1; page <= pages; page++) {
    const url   = `${BASE}/${site}/campaign/=/per_page/100/page/${page}.html`;
    const codes = await _fetchAndParse(url, parser.parseSalePage, site);
    count += _upsertDiscovered(codes, site);

    if (codes.length === 0) break;
    await sleep(config.fetch.rateLimit);
  }

  log.debug('[discovery] sale', site, count);
  return count;
}

// ─── source: known circles ───────────────────────────────────────────────────

/**
 * For every known maker_id in the DB, fetch their circle page
 * to discover new works they've released.
 *
 * Rate-limited to avoid hammering DLsite.
 * Only runs for circles where we already have ≥1 work tracked.
 *
 * Circle-sale insight: if any work in a circle is on sale,
 * the rest likely are too. Discovery triggers detail fetch boost.
 */
async function _discoverFromKnownCircles() {
  const makerIds = db.getAllMakerIds();
  let count = 0;

  // Stagger circle discovery: only run up to 20 per session
  const batch = makerIds.slice(0, 20);

  for (const makerId of batch) {
    for (const site of config.dlsite.sites) {
      const url   = `${BASE}/${site}/circle/works/=/maker_id/${makerId}/order/release_d.html`;
      const codes = await _fetchAndParse(url, parser.parseCircleWorks, site);
      count += _upsertDiscovered(codes, site);

      await sleep(config.fetch.rateLimit);
    }
  }

  log.debug('[discovery] circles scanned', batch.length, 'new codes', count);
  return count;
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function _fetchAndParse(url, parseFn, siteId) {
  try {
    const res = await fetchWithRetry(url);

    if (!res.ok) {
      log.warn('[discovery] non-200', res.status, url);
      return [];
    }

    const html  = await res.text();
    const codes = parseFn(html);
    return codes;
  } catch (err) {
    log.error('[discovery] fetch error', url, err.message);
    return [];
  }
}

/** Upsert RJ codes with minimal metadata; returns count of newly inserted. */
function _upsertDiscovered(codes, siteId) {
  let count = 0;
  for (const rjCode of codes) {
    const existing = db.getWorkByRj(rjCode);
    if (!existing) {
      db.upsertWork({
        rj_code:      rjCode,
        title:        null,
        circle:       null,
        maker_id:     null,
        work_type:    null,
        site_id:      siteId,
        release_date: null,
        dl_count:     0,
      });
      count++;
    }
  }
  return count;
}

module.exports = { runDiscovery };
