'use strict';

/**
 * crawler/queue.js
 * Priority request queue.
 *
 * - Concurrency limited to config.fetch.concurrency
 * - Rate limit: minimum config.fetch.rateLimit ms between dispatches
 * - Deduplication by (url)
 * - FIFO within same priority tier
 */

const config = require('../config');
const log    = require('./logger');

class RequestQueue {
  constructor() {
    this._items       = [];         // { url, priority, resolve, reject, id }
    this._inFlight    = 0;
    this._lastRequest = 0;          // timestamp ms
    this._seen        = new Set();  // dedup by url within this queue instance
    this._timer       = null;
    this._draining    = false;
  }

  /**
   * Enqueue a fetch request.
   * @param {string}   url
   * @param {object}   fetchOpts  - passed to native fetch()
   * @param {number}   priority   - higher = sooner
   * @returns {Promise<Response>}
   */
  enqueue(url, fetchOpts = {}, priority = 20) {
    if (this._seen.has(url)) {
      log.debug('[queue] dedup skip', url);
      return Promise.resolve(null); // caller must handle null
    }
    this._seen.add(url);

    return new Promise((resolve, reject) => {
      this._items.push({ url, fetchOpts, priority, resolve, reject });
      // sort descending by priority, stable (insertion order preserved within tier)
      this._items.sort((a, b) => b.priority - a.priority);
      this._scheduleDrain();
    });
  }

  /** Clear the dedup set so a URL can be re-enqueued in a future cycle. */
  resetSeen() {
    this._seen.clear();
  }

  _scheduleDrain() {
    if (this._timer) return;
    this._timer = setImmediate(() => {
      this._timer = null;
      this._drain();
    });
  }

  _drain() {
    const maxConcurrent = config.fetch.concurrency;
    const rateLimit     = config.fetch.rateLimit;

    if (this._items.length === 0) return;
    if (this._inFlight >= maxConcurrent) return;

    const now  = Date.now();
    const wait = rateLimit - (now - this._lastRequest);

    if (wait > 0) {
      setTimeout(() => this._drain(), wait);
      return;
    }

    const item = this._items.shift();
    if (!item) return;

    this._inFlight++;
    this._lastRequest = Date.now();
    log.debug('[queue] dispatch', item.url);

    _fetchWithTimeout(item.url, item.fetchOpts)
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        this._inFlight--;
        this._drain(); // try next
      });

    // if concurrency allows, schedule another immediately
    if (this._inFlight < maxConcurrent && this._items.length > 0) {
      this._scheduleDrain();
    }
  }

  get pending() { return this._items.length; }
  get active()  { return this._inFlight; }
}

// ─── fetch with timeout (native fetch, Node 18+) ────────────────────────────

async function _fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(
    () => controller.abort(new Error(`Timeout after ${config.fetch.timeout}ms`)),
    config.fetch.timeout
  );

  try {
    const headers = {
      'User-Agent': config.dlsite.userAgent,
      'Cookie':     config.dlsite.locale,
      'Accept-Language': 'ja,en;q=0.9',
      'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...opts.headers,
    };

    const res = await fetch(url, {
      ...opts,
      headers,
      signal: controller.signal,
    });

    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Standalone fetch with retry+backoff. Does NOT go through the queue.
 * Use for high-priority single fetches (e.g. detail fetcher).
 */
async function fetchWithRetry(url, opts = {}) {
  const maxRetry  = config.fetch.retryMax;
  const baseDelay = config.fetch.retryBaseDelay;
  let lastErr;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      const res = await _fetchWithTimeout(url, opts);

      // DLsite returns 429 for rate-limit, 503 for maintenance
      if (res.status === 429 || res.status === 503) {
        const wait = baseDelay * Math.pow(2, attempt);
        log.warn(`[fetch] ${res.status} on attempt ${attempt + 1}, wait ${wait}ms`, url);
        await sleep(wait);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }

      return res;
    } catch (err) {
      const isAbort = err.name === 'AbortError' || err.message?.includes('Timeout');
      const wait    = baseDelay * Math.pow(2, attempt);
      log.warn(`[fetch] attempt ${attempt + 1} failed (${err.message}), wait ${wait}ms`, url);
      await sleep(wait);
      lastErr = err;
    }
  }

  throw lastErr ?? new Error(`fetchWithRetry: all attempts failed for ${url}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Singleton queue instance shared across the process
const globalQueue = new RequestQueue();

module.exports = { RequestQueue, globalQueue, fetchWithRetry, sleep };
