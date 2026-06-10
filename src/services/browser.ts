/*
 * File: browser.ts
 * Project: kimiproxy
 * Multi-profile persistent-browser manager for DOM-driven providers
 * (DeepSeek, Qwen). Kimi keeps its own dedicated context in playwright.ts.
 *
 * Each provider gets an isolated persistent profile under `profiles/<id>` so
 * sessions never collide, plus a per-profile mutex so only one generation
 * drives a given site's UI at a time.
 */

import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright';
import path from 'path';
import type { BrowserType } from './playwright.ts';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

interface ProfileHandle {
  context: BrowserContext;
  page: Page;
  mutex: Mutex;
}

export interface ProfileSession {
  page: Page;
  /** Run `fn` while holding the profile's UI lock (serializes generations). */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Acquire the UI lock manually; call the returned function to release. */
  acquire(): Promise<() => void>;
}

const handles = new Map<string, ProfileHandle>();
const initLocks = new Map<string, Promise<ProfileHandle>>();

export interface GetProfileOptions {
  browserType?: BrowserType;
  headless?: boolean;
  /** Navigated to once on first launch so the persisted session loads. */
  loginUrl?: string;
}

function resolveEngine(browserType: BrowserType): {
  engine: typeof chromium | typeof firefox | typeof webkit;
  channel?: string;
} {
  switch (browserType) {
    case 'firefox':
      return { engine: firefox };
    case 'webkit':
      return { engine: webkit };
    case 'chrome':
      return { engine: chromium, channel: 'chrome' };
    case 'edge':
      return { engine: chromium, channel: 'msedge' };
    case 'chromium':
    default:
      return { engine: chromium };
  }
}

async function launch(
  profileId: string,
  opts: GetProfileOptions
): Promise<ProfileHandle> {
  const browserType = opts.browserType ?? 'chromium';
  const headless = opts.headless ?? true;
  const profilePath = path.resolve(process.env.PROFILES_DIR || 'profiles', profileId);
  const { engine, channel } = resolveEngine(browserType);

  const args: string[] = [];
  const ignoreDefaultArgs: string[] = [];
  if (browserType === 'chromium' || browserType === 'chrome' || browserType === 'edge') {
    args.push('--disable-blink-features=AutomationControlled');
    ignoreDefaultArgs.push('--enable-automation');
  }

  console.log(`[Browser:${profileId}] Launching ${browserType} (headless=${headless})...`);
  const context = await engine.launchPersistentContext(profilePath, {
    headless,
    channel,
    args,
    ignoreDefaultArgs,
    userAgent: DEFAULT_USER_AGENT,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // tsx/esbuild wraps functions passed to page.evaluate() with a __name()
    // helper that doesn't exist in the page context, throwing "__name is not
    // defined". Provide a harmless fallback so DOM reads work under tsx.
    const w = window as any;
    if (typeof w.__name === 'undefined') w.__name = (fn: any) => fn;
  });

  const page = context.pages()[0] ?? (await context.newPage());
  if (opts.loginUrl) {
    await page.goto(opts.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  return { context, page, mutex: new Mutex() };
}

/**
 * Get (launching on first use) an isolated browser session for a provider.
 * Concurrent callers during init share the same launch.
 */
export async function getProfileSession(
  profileId: string,
  opts: GetProfileOptions = {}
): Promise<ProfileSession> {
  let handle = handles.get(profileId);
  if (!handle) {
    let pending = initLocks.get(profileId);
    if (!pending) {
      pending = launch(profileId, opts).then((h) => {
        handles.set(profileId, h);
        initLocks.delete(profileId);
        return h;
      });
      initLocks.set(profileId, pending);
    }
    handle = await pending;
  }

  const h = handle;
  return {
    page: h.page,
    acquire: () => h.mutex.acquire(),
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      const release = await h.mutex.acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export async function closeAllProfiles(): Promise<void> {
  for (const [id, handle] of handles) {
    await handle.context.close().catch(() => {});
    handles.delete(id);
  }
}
