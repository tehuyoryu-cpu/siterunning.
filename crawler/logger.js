'use strict';

/**
 * crawler/logger.js
 * Minimal structured logger. No external dependencies.
 * Outputs ISO timestamp + level + message to stdout/stderr.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const ENV_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const MIN_LEVEL = LEVELS[ENV_LEVEL] ?? 1;

function _log(level, ...args) {
  if ((LEVELS[level] ?? 0) < MIN_LEVEL) return;

  const ts  = new Date().toISOString();
  const msg = args.map(a =>
    typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a)
  ).join(' ');

  const line = `${ts} [${level.toUpperCase()}] ${msg}`;

  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

module.exports = {
  debug: (...a) => _log('debug', ...a),
  info:  (...a) => _log('info',  ...a),
  warn:  (...a) => _log('warn',  ...a),
  error: (...a) => _log('error', ...a),
};
