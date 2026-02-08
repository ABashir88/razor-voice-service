// src/integrations/config.js
// Reads all integration env vars and exposes enabled-service discovery.

import 'dotenv/config';
import makeLogger from '../utils/logger.js';

const log = makeLogger('IntegrationConfig');

// ---------------------------------------------------------------------------
// Env-var mapping — each service lists the keys it needs and which subset
// is *required* (all required keys must be present to consider the service
// "enabled").
// ---------------------------------------------------------------------------
const SERVICE_DEFS = {
  salesloft: {
    keys: {
      apiKey: 'SALESLOFT_API_KEY',
    },
    required: ['apiKey'],
  },
  salesforce: {
    keys: {
      orgAlias:      'SF_ORG_ALIAS',
      clientId:      'SF_CLIENT_ID',
      clientSecret:  'SF_CLIENT_SECRET',
      refreshToken:  'SF_REFRESH_TOKEN',
      instanceUrl:   'SF_INSTANCE_URL',
      username:      'SF_USERNAME',
      password:      'SF_PASSWORD',
      securityToken: 'SF_SECURITY_TOKEN',
      loginUrl:      'SF_LOGIN_URL',
    },
    // sf CLI (Okta SSO) OR OAuth refresh OR username/password
    requiredOneOf: [
      ['orgAlias'],                                                   // sf CLI
      ['clientId', 'clientSecret', 'refreshToken', 'instanceUrl'],   // OAuth
      ['username', 'password'],                                       // User/pass
    ],
  },
  google: {
    keys: {
      gogAccount:        'GOG_ACCOUNT',
      gogKeyringPassword: 'GOG_KEYRING_PASSWORD',
    },
    required: ['gogAccount'],
  },
  fellow: {
    keys: {
      apiKey:    'FELLOW_API_KEY',
      subdomain: 'FELLOW_SUBDOMAIN',
    },
    required: ['apiKey', 'subdomain'],
  },
  braveSearch: {
    keys: {
      apiKey: 'BRAVE_SEARCH_API_KEY',
    },
    required: ['apiKey'],
  },
};

// ---------------------------------------------------------------------------
// Build the frozen config object
// ---------------------------------------------------------------------------
function buildConfig() {
  const cfg = {};

  for (const [service, def] of Object.entries(SERVICE_DEFS)) {
    const section = {};
    for (const [prop, envKey] of Object.entries(def.keys)) {
      section[prop] = process.env[envKey] || null;
    }
    cfg[service] = Object.freeze(section);
  }

  return Object.freeze(cfg);
}

// ---------------------------------------------------------------------------
// Determine which services have enough config to be considered enabled.
// ---------------------------------------------------------------------------
function resolveEnabled(cfg) {
  const enabled = [];

  for (const [service, def] of Object.entries(SERVICE_DEFS)) {
    const section = cfg[service];

    if (def.required) {
      // Simple mode: every required key must be non-null
      const ok = def.required.every((k) => section[k]);
      if (ok) enabled.push(service);
      else log.info(`${service}: disabled (missing required keys)`);
    } else if (def.requiredOneOf) {
      // At least one complete key-set must be present
      const ok = def.requiredOneOf.some((set) =>
        set.every((k) => section[k]),
      );
      if (ok) enabled.push(service);
      else log.info(`${service}: disabled (no valid auth set found)`);
    }
  }

  return Object.freeze(enabled);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** Frozen object mapping service → { key: value | null } */
export const integrationConfig = buildConfig();

/** Returns a frozen string[] of service names that have valid config. */
export function getEnabledIntegrations() {
  return resolveEnabled(integrationConfig);
}

// Log at import time so operators can see what's live.
const enabled = getEnabledIntegrations();
log.info(`Enabled integrations: ${enabled.length ? enabled.join(', ') : '(none)'}`);

export default integrationConfig;
