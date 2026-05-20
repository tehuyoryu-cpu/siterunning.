'use strict';

module.exports = {
  db: {
    path: './dlsite.db',
  },

  fetch: {
    timeout: 20000,       // ms per request
    retryMax: 3,
    retryBaseDelay: 3000, // ms, doubles each retry
    concurrency: 2,       // parallel requests
    rateLimit: 2000,      // ms minimum between requests (same host)
  },

  // node-cron expressions
  cron: {
    discovery: '0 */6 * * *',   // discovery run every 6h
    detail:    '*/20 * * * *',  // detail queue flush every 20min
    saleBoost: '*/10 * * * *',  // re-prioritise sale works every 10min
  },

  // seconds between re-checks per work state
  checkInterval: {
    onSale:    2  * 60 * 60,   // 2h
    newWork:   6  * 60 * 60,   // 6h  (released < 7 days ago)
    recentWork:12 * 60 * 60,   // 12h (released < 30 days)
    popular:   12 * 60 * 60,   // 12h (dl_count > 1000)
    normal:    24 * 60 * 60,   // 24h
    cold:      72 * 60 * 60,   // 72h (≥5 checks with no price change)
  },

  // higher = checked first
  priority: {
    onSale:     100,
    circleOnSale: 90,
    newWork:     80,
    recentWork:  50,
    popular:     40,
    normal:      20,
    cold:         5,
  },

  dlsite: {
    // non-adult works can be on "home", adult on "maniax"
    sites: ['maniax', 'home'],
    baseUrl: 'https://www.dlsite.com',
    // pages per discovery run per source
    discoveryPages: {
      new:     5,
      ranking: 3,
      sale:    5,
    },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    // ja-jp locale required to get JPY prices
    locale: 'locale=ja-jp',
  },
};
