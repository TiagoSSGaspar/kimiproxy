/*
 * File: middleware/security.ts
 * Project: kimiproxy
 * Lightweight, dependency-free security middleware:
 *  - body size cap (reject oversized payloads early)
 *  - in-memory token-bucket rate limiting per client IP
 *  - CORS origin allowlist helper
 *
 * Defaults are generous so local single-user usage is never throttled; tune
 * via env (see .env.example).
 */

import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'crypto';

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Optional API-key auth. If API_KEY is unset, requests pass through (open —
 * meant for localhost use). If set, the request must carry the key as either
 * `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 */
export function apiKeyAuth() {
  return async (c: Context, next: Next) => {
    const key = process.env.API_KEY;
    if (!key) return next();

    const auth = c.req.header('authorization') || '';
    const bearer = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : '';
    const provided = bearer || c.req.header('x-api-key') || '';

    if (provided && safeEqual(provided, key)) return next();
    return c.json({ error: 'Unauthorized' }, 401);
  };
}

function clientKey(c: Context): string {
  // Behind a proxy these may be spoofable; for a local/self-hosted tool the
  // direct socket address (when available) plus forwarded header is enough.
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  const info = (c as any).env?.incoming?.socket?.remoteAddress;
  return info || 'local';
}

/** Reject requests whose Content-Length exceeds `maxBytes`. */
export function bodyLimit(maxBytes: number) {
  return async (c: Context, next: Next) => {
    const len = Number(c.req.header('content-length') || '0');
    if (len && len > maxBytes) {
      return c.json(
        { error: { message: `Request body too large (max ${maxBytes} bytes)`, type: 'payload_too_large' } },
        413
      );
    }
    return next();
  };
}

interface Bucket {
  tokens: number;
  updated: number;
}

/**
 * Token-bucket rate limiter. `limit` requests per `windowMs`, refilled
 * continuously. Keyed per client IP.
 */
export function rateLimit(limit: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();
  const refillPerMs = limit / windowMs;

  return async (c: Context, next: Next) => {
    const key = clientKey(c);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: limit, updated: now };
      buckets.set(key, b);
    } else {
      b.tokens = Math.min(limit, b.tokens + (now - b.updated) * refillPerMs);
      b.updated = now;
    }

    if (b.tokens < 1) {
      const retryMs = Math.ceil((1 - b.tokens) / refillPerMs);
      c.header('Retry-After', String(Math.ceil(retryMs / 1000)));
      return c.json(
        { error: { message: 'Rate limit exceeded', type: 'rate_limit_exceeded' } },
        429
      );
    }

    b.tokens -= 1;

    // Opportunistic cleanup to bound memory.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) {
        if (now - v.updated > windowMs * 4) buckets.delete(k);
      }
    }

    return next();
  };
}

/**
 * Build the `origin` option for hono's cors() from a comma-separated allowlist.
 * Empty/unset -> no cross-origin allowed (returns '' so the browser blocks).
 * '*' -> allow any origin (explicit opt-in).
 */
export function corsOrigin(allowlist: string | undefined) {
  if (allowlist && allowlist.trim() === '*') {
    return '*';
  }
  const allowed = (allowlist || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return (origin: string): string => (allowed.includes(origin) ? origin : '');
}
