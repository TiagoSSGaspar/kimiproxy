/*
 * File: index.ts
 * Project: kimiproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { chatCompletions } from './routes/chat.ts';
import { allModels } from './providers/index.ts';
import { bodyLimit, rateLimit, corsOrigin } from './middleware/security.ts';
import * as dotenv from 'dotenv';
import { initPlaywright, BrowserType } from './services/playwright.ts';
import { networkInterfaces } from 'os';

dotenv.config();

export const app = new Hono();

// CORS restricted to an allowlist (CORS_ORIGINS, comma-separated). Default:
// no cross-origin access (a local API doesn't need it). Set '*' to open up.
app.use('*', cors({ origin: corsOrigin(process.env.CORS_ORIGINS) }));

// Helper to get local network IPs
function getNetworkAddress() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// Request-size guard + per-IP rate limiting on the API surface.
const MAX_BODY_BYTES = process.env.MAX_BODY_BYTES ? parseInt(process.env.MAX_BODY_BYTES) : 10 * 1024 * 1024;
const RATE_LIMIT = process.env.RATE_LIMIT ? parseInt(process.env.RATE_LIMIT) : 120;
const RATE_WINDOW_MS = process.env.RATE_WINDOW_MS ? parseInt(process.env.RATE_WINDOW_MS) : 60_000;

app.use('/v1/*', bodyLimit(MAX_BODY_BYTES));
app.use('/v1/*', rateLimit(RATE_LIMIT, RATE_WINDOW_MS));

// API Key protection middleware
app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    return await next();
  }
  return bearerAuth({ token: apiKey })(c, next);
});

// Basic health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: allModels()
  });
});

// Initialize playwright when server starts
import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Security: refuse to start unauthenticated unless explicitly allowed.
  if (!process.env.API_KEY && process.env.ALLOW_NO_AUTH !== 'true') {
    console.error('\n❌ Refusing to start without API_KEY.');
    console.error('   Set API_KEY in your .env to protect the proxy, or set');
    console.error('   ALLOW_NO_AUTH=true to run an UNAUTHENTICATED server (not recommended).\n');
    process.exit(1);
  }

  // Bind to localhost by default; only expose on the network when HOST is set
  // explicitly (e.g. HOST=0.0.0.0).
  const host = process.env.HOST || '127.0.0.1';

  // Parse browser type from args or env
  let browserType: BrowserType = 'chromium';
  const browserArg = process.argv.find(arg => arg.startsWith('--browser='));
  if (browserArg) {
    browserType = browserArg.split('=')[1] as BrowserType;
  } else if (process.env.BROWSER) {
    browserType = process.env.BROWSER as BrowserType;
  }

  initPlaywright(true, browserType).then(() => {
    console.log(`Playwright initialized (${browserType}).`);
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

    console.log('\n🚀 KimiProxy started!');
    console.log(`- Local:   http://localhost:${port}`);
    if (host === '0.0.0.0') {
      const networkIP = getNetworkAddress();
      if (networkIP) {
        console.log(`- Network: http://${networkIP}:${port}  (exposed: HOST=0.0.0.0)`);
      }
    }

    console.log('\nAvailable Routes:');
    app.routes.forEach(route => {
      console.log(`- [${route.method}] ${route.path}`);
    });
    console.log('');

    serve({
      fetch: app.fetch,
      port,
      hostname: host
    });
  }).catch((err: any) => {
    console.error('Failed to initialize playwright:', err);
    process.exit(1);
  });
}
