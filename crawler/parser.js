'use strict';

/**
 * crawler/parser.js
 * Parses DLsite responses into normalised data structures.
 *
 * Two data sources:
 *   1. product/info/ajax  → JSON (price, circle, meta)
 *   2. works listing HTML  → RJ code list (discovery)
 *
 * DOM-change resilience:
 *   - Use multiple selector fallbacks per field
 *   - Never throw on missing field; return null and log
 */

const cheerio = require('cheerio');
const log     = require('./logger');

// ─── Product Info API (JSON) ─────────────────────────────────────────────────

/**
 * Parse the response body from:
 *   /maniax/product/info/ajax?product_id=RJ123456
 *
 * @param {string} rjCode
 * @param {object} body  – parsed JSON (may contain multiple RJ keys)
 * @returns {{ work, price } | null}
 */
function parseProductInfo(rjCode, body) {
  try {
    const data = body[rjCode];
    if (!data) {
      log.warn('[parser] product info: key not found', rjCode);
      return null;
    }

    // price resolution: DLsite may return price_work or price
    const rawPrice     = _int(data.price_work ?? data.price);
    const rawSalePrice = data.is_sale ? _int(data.price_without_tax_sale ?? data.price_sale) : null;
    const discountRate = data.discount_rate ? _int(data.discount_rate) : null;
    const point        = _int(data.point ?? data.dl_point);

    const work = {
      rj_code:      rjCode,
      title:        _str(data.work_name ?? data.name),
      circle:       _str(data.maker_name ?? data.brand_name),
      maker_id:     _str(data.maker_id),
      work_type:    _str(data.work_type),
      site_id:      _str(data.site_id ?? 'maniax'),
      release_date: _str(data.regist_date ?? data.product_date),
      dl_count:     _int(data.dl_count ?? data.down_count),
    };

    const price = {
      price:         rawPrice,
      sale_price:    rawSalePrice,
      point:         point,
      discount_rate: discountRate,
      is_on_sale:    data.is_sale ? 1 : 0,
    };

    return { work, price };
  } catch (err) {
    log.error('[parser] parseProductInfo error', rjCode, err.message);
    return null;
  }
}

// ─── Works Listing HTML (discovery) ─────────────────────────────────────────

/**
 * Extract RJ codes from a works listing HTML page.
 * Tries multiple selector strategies in order.
 *
 * @param {string} html
 * @returns {string[]}  array of RJ codes like ['RJ123456', ...]
 */
function parseWorkList(html) {
  try {
    const $ = cheerio.load(html);
    const codes = new Set();

    // Strategy 1: data-product_id attributes (most stable)
    $('[data-product_id]').each((_, el) => {
      const val = $(el).attr('data-product_id');
      const rj  = _extractRj(val);
      if (rj) codes.add(rj);
    });

    // Strategy 2: links containing /product_id/RJ
    $('a[href*="/product_id/RJ"]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const rj   = _extractRj(href);
      if (rj) codes.add(rj);
    });

    // Strategy 3: dl.work_img_main or similar containers
    $('dt.work_img_main a, .work_name a').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const rj   = _extractRj(href);
      if (rj) codes.add(rj);
    });

    // Strategy 4: any href containing RJ followed by digits
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const rj   = _extractRj(href);
      if (rj) codes.add(rj);
    });

    const result = [...codes];
    log.debug('[parser] parseWorkList found', result.length, 'codes');
    return result;
  } catch (err) {
    log.error('[parser] parseWorkList error', err.message);
    return [];
  }
}

/**
 * Extract RJ codes from ranking HTML.
 * Same as parseWorkList but separate for clarity / future divergence.
 */
function parseRankingList(html) {
  return parseWorkList(html); // ranking uses same selector strategies
}

/**
 * Parse circle works page to extract all RJ codes for that circle.
 */
function parseCircleWorks(html) {
  return parseWorkList(html);
}

/**
 * Parse sale/campaign page for RJ codes currently on sale.
 */
function parseSalePage(html) {
  return parseWorkList(html);
}

// ─── helpers ────────────────────────────────────────────────────────────────

const RJ_PATTERN = /\b(RJ\d{6,8})\b/i;

function _extractRj(str) {
  if (!str) return null;
  const m = str.match(RJ_PATTERN);
  return m ? m[1].toUpperCase() : null;
}

function _int(v) {
  if (v === null || v === undefined) return null;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function _str(v) {
  if (v === null || v === undefined) return null;
  return String(v).trim() || null;
}

module.exports = {
  parseProductInfo,
  parseWorkList,
  parseRankingList,
  parseCircleWorks,
  parseSalePage,
};
