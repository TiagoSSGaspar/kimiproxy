/*
 * File: dom/domProvider.ts
 * Project: kimiproxy
 * Generic DOM-driving provider: types a prompt into a site's chat box and
 * streams the assistant's reply by polling the DOM. Used for sites whose
 * private API can't be replayed (DeepSeek's per-message WASM proof-of-work,
 * MiMo's undocumented protocol).
 *
 * Selectors are configured per site (deepseek.ts / mimo.ts). Because real
 * markup can't be inspected from here, defaults are best-effort and may need
 * calibration after the first manual login. Run with DOM_DEBUG=1 to dump a
 * screenshot + HTML of the page to help adjust selectors.
 */

import type { BrowserType } from '../../services/playwright.ts';
import { getProfileSession } from '../../services/browser.ts';
import type {
  CreateStreamOptions,
  ModelInfo,
  Provider,
  ProviderStream,
  UnifiedDelta,
} from '../types.ts';

export interface DomSiteConfig {
  /** Provider id, also the model-name prefix. */
  id: string;
  ownedBy: string;
  /** Page opened on first launch so the persisted session loads. */
  loginUrl: string;
  /** Origin used to detect whether we're already on the site. */
  origin: string;
  /** Internal model names this provider exposes. */
  models: string[];
  selectors: {
    /** Chat input (textarea or contenteditable). CSS list (comma-separated) ok. */
    input: string;
    /** Send button. Optional — falls back to pressing Enter. */
    send?: string;
    /** Container(s) of assistant replies; the LAST match is the current one. */
    assistantMessage: string;
    /** Reasoning / thinking panel, if the site exposes one. */
    reasoning?: string;
    /** Element present only while the model is generating (e.g. stop button). */
    generating?: string;
  };
  browserType?: BrowserType;
  headless?: boolean;
  /** Extra wait (ms) after navigation for the SPA to hydrate/apply auth. */
  settleMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const POLL_MS = 300;
const MAX_GEN_MS = 180_000;
const STABLE_TICKS = 10; // ~3s of no new text before we consider it done
const FIRST_TOKEN_TIMEOUT_MS = 60_000; // patience for the first token (long "thinking" phases)

export class DomProvider implements Provider {
  readonly id: string;
  private cfg: DomSiteConfig;

  constructor(cfg: DomSiteConfig) {
    this.id = cfg.id;
    this.cfg = cfg;
  }

  models(): ModelInfo[] {
    const created = Math.floor(Date.now() / 1000);
    return this.cfg.models.map((name) => ({
      id: `${this.id}/${name}`,
      object: 'model' as const,
      created,
      owned_by: this.cfg.ownedBy,
    }));
  }

  async createStream(opts: CreateStreamOptions): Promise<ProviderStream> {
    const cfg = this.cfg;
    const session = await getProfileSession(cfg.id, {
      browserType: cfg.browserType,
      headless: cfg.headless,
      loginUrl: cfg.loginUrl,
    });

    return (async function* (): AsyncGenerator<UnifiedDelta> {
      const release = await session.acquire();
      const page = session.page;
      try {
        // DOM providers are stateless per request: the chat route re-sends the
        // full flattened history every time, so we always open a fresh chat
        // (navigating to the site root) to avoid context accumulating. The only
        // exception is a Kimi-style "continue" follow-up, which DOM backends
        // don't emit — so this is effectively always-fresh here.
        const settle = cfg.settleMs ?? 1200;
        if (opts.prompt !== 'continue') {
          await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' });
          await sleep(settle);
        } else if (!page.url().startsWith(cfg.origin)) {
          await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' });
        }

        const input = page.locator(cfg.selectors.input).first();
        await input.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {
          throw new Error(
            `[${cfg.id}] chat input not found (selector: ${cfg.selectors.input}). Are you logged in? Run npm run login:${cfg.id}.`
          );
        });

        // Set the whole prompt at once (no per-key Enter, so multiline is safe).
        await input.click();
        try {
          await input.fill(opts.prompt);
        } catch {
          await page.keyboard.insertText(opts.prompt);
        }

        // Let the framework register the input and enable the send button
        // before we try to submit.
        await sleep(700);
        await submit(page, cfg, input);

        let lastText = '';
        let lastReasoning = '';
        let stable = 0;
        let sawText = false;
        const start = Date.now();

        while (Date.now() - start < MAX_GEN_MS) {
          await sleep(POLL_MS);
          const snap = await readSnapshot(page, cfg).catch(() => null);
          if (!snap) continue;

          if (snap.reasoning.length > lastReasoning.length) {
            yield { type: 'reasoning', text: snap.reasoning.slice(lastReasoning.length) };
            lastReasoning = snap.reasoning;
          }

          if (snap.text.length > lastText.length) {
            yield { type: 'text', text: snap.text.slice(lastText.length) };
            lastText = snap.text;
            sawText = true;
            stable = 0;
          } else {
            stable++;
          }

          // Before the first token, be patient (thinking phases can be long);
          // only give up if nothing arrives within FIRST_TOKEN_TIMEOUT_MS.
          // Once streaming, finish when text stabilises and it's not generating.
          const settled = sawText
            ? !snap.generating && stable >= STABLE_TICKS
            : Date.now() - start > FIRST_TOKEN_TIMEOUT_MS;
          if (settled) break;
        }

        if (process.env.DOM_DEBUG) {
          await dumpDebug(page, cfg.id).catch(() => {});
        }

        yield { type: 'done', paused: false };
      } finally {
        release();
      }
    })();
  }
}

async function submit(page: any, cfg: DomSiteConfig, input: any): Promise<void> {
  // Prefer clicking the send button (last match: it's typically the rightmost
  // primary action), then verify the input actually cleared — if not, the click
  // didn't register, so fall back to Enter.
  if (cfg.selectors.send) {
    const btn = page.locator(cfg.selectors.send).last();
    try {
      if (await btn.isVisible()) {
        await btn.click({ timeout: 3000 });
      }
    } catch {
      // fall through to the Enter fallback below
    }
  }

  await sleep(600);
  let remaining = '';
  try {
    remaining = (await input.inputValue()) || '';
  } catch {
    // contenteditable inputs don't support inputValue(); assume sent.
    return;
  }
  if (remaining.trim().length > 0) {
    await input.focus();
    await page.keyboard.press('Enter');
  }
}

interface DomSnapshot {
  text: string;
  reasoning: string;
  generating: boolean;
}

async function readSnapshot(page: any, cfg: DomSiteConfig): Promise<DomSnapshot> {
  // IMPORTANT: keep this evaluate body FLAT (no inner function declarations).
  // tsx/esbuild wraps named/arrow functions with a __name() helper that does
  // not exist in the page context, which throws "__name is not defined".
  return page.evaluate(
    (sels: Record<string, string | undefined>) => {
      const aNodes = sels.assistant ? document.querySelectorAll(sels.assistant) : [];
      const aEl = aNodes[aNodes.length - 1] as HTMLElement | undefined;
      const text = aEl ? (aEl.innerText || '').trim() : '';

      const rNodes = sels.reasoning ? document.querySelectorAll(sels.reasoning) : [];
      const rEl = rNodes[rNodes.length - 1] as HTMLElement | undefined;
      const reasoning = rEl ? (rEl.innerText || '').trim() : '';

      const generating = sels.generating ? !!document.querySelector(sels.generating) : false;
      return { text, reasoning, generating };
    },
    {
      assistant: cfg.selectors.assistantMessage,
      reasoning: cfg.selectors.reasoning,
      generating: cfg.selectors.generating,
    }
  );
}

async function dumpDebug(page: any, id: string): Promise<void> {
  const stamp = Date.now();
  const png = `dom-debug-${id}-${stamp}.png`;
  const html = `dom-debug-${id}-${stamp}.html`;
  await page.screenshot({ path: png, fullPage: true }).catch(() => {});
  const content = await page.content().catch(() => '');
  const fs = await import('fs');
  fs.writeFileSync(html, content);
  console.log(`[${id}] DOM_DEBUG wrote ${png} and ${html}`);
}
