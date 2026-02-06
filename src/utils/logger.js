// src/utils/logger.js – Structured logger with levels and color
import config from '../config.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = {
  debug: '\x1b[90m',   // gray
  info:  '\x1b[36m',   // cyan
  warn:  '\x1b[33m',   // yellow
  error: '\x1b[31m',   // red
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
};

const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
}

function makeLogger(tag) {
  const prefix = `${COLORS.bold}[${tag}]${COLORS.reset}`;

  return {
    debug(...args) {
      if (currentLevel <= LEVELS.debug)
        console.log(`${COLORS.debug}${ts()}${COLORS.reset} ${prefix}`, ...args);
    },
    info(...args) {
      if (currentLevel <= LEVELS.info)
        console.log(`${COLORS.info}${ts()}${COLORS.reset} ${prefix}`, ...args);
    },
    warn(...args) {
      if (currentLevel <= LEVELS.warn)
        console.warn(`${COLORS.warn}${ts()}${COLORS.reset} ${prefix}`, ...args);
    },
    error(...args) {
      if (currentLevel <= LEVELS.error)
        console.error(`${COLORS.error}${ts()}${COLORS.reset} ${prefix}`, ...args);
    },
  };
}

export default makeLogger;
