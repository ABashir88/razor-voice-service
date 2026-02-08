// src/utils/error-handler.js
// Graceful Error Handler — converts technical errors into human-friendly responses.

import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const ERROR_LOG_PATH = join(PROJECT_ROOT, 'logs', 'errors.log');

// Ensure logs dir exists on load
try { mkdirSync(join(PROJECT_ROOT, 'logs'), { recursive: true }); } catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Human-friendly error response pools
// ---------------------------------------------------------------------------
const ERROR_RESPONSES = {
  // Salesforce
  salesforce_timeout: [
    "Salesforce is being slow. Give me a sec...",
    "CRM's taking its time. One more try...",
    "Hang on, Salesforce is lagging...",
  ],
  salesforce_auth: [
    "Lost connection to Salesforce. Might need to re-authenticate.",
    "Salesforce session expired. Try reconnecting.",
  ],
  salesforce_notfound: [
    "Couldn't find that in Salesforce.",
    "Nothing matching that in the CRM.",
  ],
  salesforce_error: [
    "Can't reach Salesforce right now.",
    "CRM's having issues. Want me to try again?",
  ],

  // Salesloft
  salesloft_timeout: [
    "Salesloft's being slow. Hang on...",
    "Engagement data's loading... one sec.",
  ],
  salesloft_auth: [
    "Salesloft connection dropped. Might need to reconnect.",
  ],
  salesloft_error: [
    "Can't reach Salesloft right now.",
    "Engagement platform's not responding.",
  ],

  // Gmail / Google
  google_timeout: [
    "Gmail's being slow. Trying again...",
    "Email's taking a moment...",
  ],
  google_auth: [
    "Lost connection to Gmail. Might need to re-authenticate.",
  ],
  google_error: [
    "Can't reach Gmail right now.",
    "Email's not connecting.",
  ],

  // Fellow
  fellow_timeout: [
    "Fellow's being slow. Hang on...",
    "Meeting notes are loading... one sec.",
  ],
  fellow_auth: [
    "Lost connection to Fellow. API key might need a refresh.",
  ],
  fellow_error: [
    "Can't reach Fellow right now.",
    "Meeting notes aren't responding.",
  ],

  // Brave Search
  brave_timeout: [
    "Web search is being slow. One sec...",
    "Research is taking a moment...",
  ],
  brave_auth: [
    "Search API connection dropped. Key might need updating.",
  ],
  brave_error: [
    "Can't search the web right now.",
    "Web research isn't available at the moment.",
  ],

  // Network
  network: [
    "Network hiccup. Let me try again.",
    "Connection dropped. One more shot...",
  ],

  // General
  general: [
    "Something's off. Let me try that again.",
    "Hmm, that didn't work. One sec...",
    "Hit a snag. Trying again...",
  ],

  // Not found
  not_found: [
    "Couldn't find that.",
    "Nothing matching that query.",
    "No results for that one.",
  ],

  // Rate limit
  rate_limit: [
    "Getting rate limited. Give it a minute.",
    "Too many requests. Let's slow down.",
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Classify an error into one of the response categories.
 * @param {Error} error
 * @param {string} service - 'salesforce' | 'salesloft' | 'google' | 'general'
 * @returns {string} Key into ERROR_RESPONSES
 */
function classifyError(error, service = 'general') {
  const message = (error?.message || '').toLowerCase();
  const code = (error?.code || '').toLowerCase();
  const status = error?.response?.status;

  // Timeout
  if (message.includes('timeout') || message.includes('timed out') || code.includes('timeout') || code === 'etimedout') {
    return `${service}_timeout`;
  }

  // Auth
  if (message.includes('auth') || message.includes('unauthorized') || message.includes('forbidden') ||
      status === 401 || status === 403) {
    return `${service}_auth`;
  }

  // Not found
  if (message.includes('not found') || message.includes('no results') || status === 404) {
    return 'not_found';
  }

  // Rate limit
  if (message.includes('rate') || message.includes('too many') || status === 429) {
    return 'rate_limit';
  }

  // Network
  if (message.includes('network') || message.includes('econnrefused') ||
      message.includes('enotfound') || message.includes('socket') ||
      code === 'econnrefused' || code === 'enotfound' || code === 'econnreset') {
    return 'network';
  }

  // Generic service error
  const serviceKey = `${service}_error`;
  return ERROR_RESPONSES[serviceKey] ? serviceKey : 'general';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a human-friendly error message for the given error.
 * @param {Error} error
 * @param {string} [service='general']
 * @returns {string}
 */
export function getErrorResponse(error, service = 'general') {
  const errorType = classifyError(error, service);
  const responses = ERROR_RESPONSES[errorType] || ERROR_RESPONSES.general;
  return randomFrom(responses);
}

/**
 * Log an error to the errors.log file and console.
 * @param {string} service
 * @param {Error} error
 * @param {object} [context={}]
 */
export function logError(service, error, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    service,
    message: error?.message,
    stack: error?.stack?.split('\n').slice(0, 3).join(' | '),
    context,
  };

  const line = JSON.stringify(entry) + '\n';

  try {
    appendFileSync(ERROR_LOG_PATH, line);
  } catch {
    // Can't log to file — continue silently
  }
}

/**
 * Wrap an async function with graceful error handling and optional retry.
 *
 * On success: returns the function's result.
 * On final failure: returns `{ error: true, message: "human-friendly string" }`.
 *
 * @param {Function} fn - Async function to execute
 * @param {string} service - Service name for error classification
 * @param {object} [options]
 * @param {number} [options.maxRetries=1] - Number of retries after first failure
 * @param {number} [options.retryDelay=1000] - ms to wait between retries
 * @param {Function} [options.onRetry] - Called with the friendly message before retry
 * @returns {Promise<any|{error: true, message: string}>}
 */
export async function withGracefulError(fn, service, options = {}) {
  const { maxRetries = 1, retryDelay = 1000, onRetry = null } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      logError(service, error, { attempt: attempt + 1 });

      if (attempt < maxRetries) {
        const retryMsg = getErrorResponse(error, service);
        if (onRetry) {
          await onRetry(retryMsg);
        }
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        return { error: true, message: getErrorResponse(error, service) };
      }
    }
  }
}

/**
 * Check if a result from withGracefulError is an error.
 * @param {any} result
 * @returns {boolean}
 */
export function isErrorResult(result) {
  return result != null && result.error === true && typeof result.message === 'string';
}

export default { getErrorResponse, withGracefulError, isErrorResult, logError };
