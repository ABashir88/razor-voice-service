#!/usr/bin/env node
// scripts/oauth-setup.js
// One-time OAuth setup CLI for Razor integrations.
// Usage: node scripts/oauth-setup.js --google | --salesforce | --all

import { createServer } from 'node:http';
import { URL, URLSearchParams } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH  = resolve(__dirname, '..', '.env');
const PORT      = 3000;
const REDIRECT  = `http://localhost:${PORT}/callback`;

// ---------------------------------------------------------------------------
// .env helpers
// ---------------------------------------------------------------------------
function readEnv() {
  if (!existsSync(ENV_PATH)) return '';
  return readFileSync(ENV_PATH, 'utf-8');
}

function upsertEnvVar(key, value) {
  let content = readEnv();
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const line  = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content.trimEnd() + '\n' + line + '\n';
  }
  writeFileSync(ENV_PATH, content, 'utf-8');
  console.log(`  ✅ ${key} written to .env`);
}

// ---------------------------------------------------------------------------
// Temporary HTTP server to capture the OAuth callback
// ---------------------------------------------------------------------------
function waitForCallback() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname === '/callback') {
        const code  = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (error) {
          res.end('<h1>OAuth Error</h1><p>You can close this tab.</p>');
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        res.end('<h1>✅ Success!</h1><p>Token captured — you can close this tab.</p>');
        server.close();
        resolvePromise(code);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(PORT, () => {
      console.log(`  🌐 Callback server listening on http://localhost:${PORT}/callback`);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for OAuth callback (120 s)'));
    }, 120_000);
  });
}

// ---------------------------------------------------------------------------
// Google OAuth flow
// ---------------------------------------------------------------------------
async function setupGoogle() {
  console.log('\n🔵 Google OAuth Setup (Gmail + Calendar)\n');

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('  ❌ GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env first.');
    console.error('     Create credentials at https://console.cloud.google.com/apis/credentials');
    return;
  }

  const scopes = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ];

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  REDIRECT,
    response_type: 'code',
    scope:         scopes.join(' '),
    access_type:   'offline',
    prompt:        'consent',
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  console.log('  Opening browser for consent…');
  await open(authUrl);

  const code = await waitForCallback();
  console.log('  🔑 Authorization code received — exchanging for tokens…');

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  REDIRECT,
      grant_type:    'authorization_code',
    }),
  });

  const tokenData = await tokenRes.json();
  if (tokenData.error) {
    console.error(`  ❌ Token exchange failed: ${tokenData.error_description || tokenData.error}`);
    return;
  }

  upsertEnvVar('GOOGLE_REFRESH_TOKEN', tokenData.refresh_token);
  console.log('  ✅ Google setup complete!\n');
}

// ---------------------------------------------------------------------------
// Salesforce OAuth flow
// ---------------------------------------------------------------------------
async function setupSalesforce() {
  console.log('\n🟢 Salesforce OAuth Setup\n');

  const clientId     = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  const loginUrl     = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

  if (!clientId || !clientSecret) {
    console.error('  ❌ SF_CLIENT_ID and SF_CLIENT_SECRET must be set in .env first.');
    console.error('     Create a Connected App in Salesforce Setup.');
    return;
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  REDIRECT,
    response_type: 'code',
    scope:         'full refresh_token',
  });

  const authUrl = `${loginUrl}/services/oauth2/authorize?${params}`;

  console.log('  Opening browser for consent…');
  await open(authUrl);

  const code = await waitForCallback();
  console.log('  🔑 Authorization code received — exchanging for tokens…');

  const tokenRes = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  REDIRECT,
      grant_type:    'authorization_code',
    }),
  });

  const tokenData = await tokenRes.json();
  if (tokenData.error) {
    console.error(`  ❌ Token exchange failed: ${tokenData.error_description || tokenData.error}`);
    return;
  }

  upsertEnvVar('SF_REFRESH_TOKEN', tokenData.refresh_token);
  upsertEnvVar('SF_INSTANCE_URL', tokenData.instance_url);
  console.log('  ✅ Salesforce setup complete!\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const args = process.argv.slice(2).map((a) => a.toLowerCase());

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
Razor OAuth Setup
─────────────────
Usage: node scripts/oauth-setup.js [flags]

Flags:
  --google       Set up Google (Gmail + Calendar)
  --salesforce   Set up Salesforce
  --all          Set up all services

Prerequisites:
  • GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET in .env (for --google)
  • SF_CLIENT_ID & SF_CLIENT_SECRET in .env (for --salesforce)
`);
  process.exit(0);
}

(async () => {
  try {
    const doAll = args.includes('--all');

    if (doAll || args.includes('--google')) {
      await setupGoogle();
    }
    if (doAll || args.includes('--salesforce')) {
      await setupSalesforce();
    }

    console.log('🎉 Done.');
  } catch (err) {
    console.error(`\n❌ Fatal: ${err.message}`);
    process.exit(1);
  }
})();
