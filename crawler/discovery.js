'use strict';

/**
 * crawler/discovery.js
 * RJコード収集。
 *
 * 効率化ポイント:
 *   - maniax/home を並列取得 (Promise.all)
 *   - 新着/ランキング/セールも並列化
 *   - 既知RJはスキップ (DB照合)
 *   - サークル探索は最大20件/セッション (変更なし)
 */

const config = require('../config');
const db     = require('./db');
const parser = require('./parser');
const log    = require('./logger');
const { fetchWithRetry, sleep } = require('./queue');

const BASE = config.dlsite.baseUrl;

// ─── メインエントリ ──────────────────────────────────────────────────────────

async function runDiscovery() {
  log.info('[discovery] start');

  // 両サイトを並列で全ソース探索
  const siteResults = await Promise.all(
    config.dlsite.sites.map(site => _discoverSite(site))
  );

  const summary = siteResults.reduce(
    (acc, r) => ({ new: acc.new + r.new, ranking: acc.ranking + r.ranking, sale: acc.sale + r.sale }),
    { new: 0, ranking: 0, sale: 0 }
  );

  summary.circle = await _discoverFromKnownCircles();

  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  log.info('[discovery] done', { total, ...summary });
  return { discovered: total, sources: summary };
}

// ─── サイト内全ソース並列取得 ────────────────────────────────────────────────

async function _discoverSite(site) {
  // 新着・ランキング・セールを並列実行 (各内部はページループのみ)
  const [newCount, rankCount, saleCount] = await Promise.all([
    _discoverNew(site),
    _discoverRanking(site),
    _discoverSale(site),
  ]);
  return { new: newCount, ranking: rankCount, sale: saleCount };
}

// ─── 新着 ────────────────────────────────────────────────────────────────────

async function _discoverNew(site) {
  let count = 0;
  for (let page = 1; page <= config.dlsite.discoveryPages.new; page++) {
    const url   = `${BASE}/${site}/new/=/per_page/100/page/${page}.html`;
    const codes = await _fetchAndParse(url, parser.parseWorkList);
    if (!codes.length) break;
    count += _upsertNew(codes, site);
    await sleep(config.fetch.rateLimit);
  }
  return count;
}

// ─── ランキング ──────────────────────────────────────────────────────────────

async function _discoverRanking(site) {
  let count = 0;
  // term別を並列取得してから集約
  const terms   = ['day', 'week', 'month'];
  const pages   = config.dlsite.discoveryPages.ranking;
  const results = await Promise.all(
    terms.map(term => _discoverRankingTerm(site, term, pages))
  );
  results.forEach(n => { count += n; });
  return count;
}

async function _discoverRankingTerm(site, term, pages) {
  let count = 0;
  for (let page = 1; page <= pages; page++) {
    const url   = `${BASE}/${site}/ranking/=/term/${term}/page/${page}.html`;
    const codes = await _fetchAndParse(url, parser.parseRankingList);
    if (!codes.length) break;
    count += _upsertNew(codes, site);
    await sleep(config.fetch.rateLimit);
  }
  return count;
}

// ─── セール ──────────────────────────────────────────────────────────────────

async function _discoverSale(site) {
  let count = 0;
  for (let page = 1; page <= config.dlsite.discoveryPages.sale; page++) {
    const url   = `${BASE}/${site}/campaign/=/per_page/100/page/${page}.html`;
    const codes = await _fetchAndParse(url, parser.parseSalePage);
    if (!codes.length) break;
    count += _upsertNew(codes, site);
    await sleep(config.fetch.rateLimit);
  }
  return count;
}

// ─── サークル ────────────────────────────────────────────────────────────────

async function _discoverFromKnownCircles() {
  const makerIds = db.getAllMakerIds().slice(0, 20);
  let count = 0;
  for (const makerId of makerIds) {
    for (const site of config.dlsite.sites) {
      const url   = `${BASE}/${site}/circle/works/=/maker_id/${makerId}/order/release_d.html`;
      const codes = await _fetchAndParse(url, parser.parseCircleWorks);
      count += _upsertNew(codes, site);
      await sleep(config.fetch.rateLimit);
    }
  }
  log.debug('[discovery] circles', makerIds.length, 'new', count);
  return count;
}

// ─── ヘルパー ────────────────────────────────────────────────────────────────

async function _fetchAndParse(url, parseFn) {
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) { log.warn('[discovery] non-200', res.status, url); return []; }
    return parseFn(await res.text());
  } catch (err) {
    log.error('[discovery] fetch error', url, err.message);
    return [];
  }
}

/** 未登録のRJだけupsert。既知はスキップして余計なDB書き込みを避ける。 */
function _upsertNew(codes, siteId) {
  let count = 0;
  for (const rjCode of codes) {
    if (!db.getWorkByRj(rjCode)) {
      db.upsertWork({ rj_code: rjCode, title: null, circle: null, maker_id: null,
        work_type: null, site_id: siteId, release_date: null, dl_count: 0 });
      count++;
    }
  }
  return count;
}

module.exports = { runDiscovery };
