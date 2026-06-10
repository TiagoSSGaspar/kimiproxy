/*
 * File: dom/mimo.ts
 * Project: kimiproxy
 * Xiaomi MiMo (aistudio.xiaomimimo.com) DOM-driving config.
 *
 * NOTE: selectors are best-effort and likely need calibration after the first
 * real login. Run `DOM_DEBUG=1 npm start` and inspect the dumped HTML, then
 * tighten the selectors below.
 */

import { DomProvider, type DomSiteConfig } from './domProvider.ts';
import type { BrowserType } from '../../services/playwright.ts';

export function createMimoProvider(
  browserType?: BrowserType,
  headless = true
): DomProvider {
  const cfg: DomSiteConfig = {
    id: 'mimo',
    ownedBy: 'xiaomi',
    loginUrl: 'https://aistudio.xiaomimimo.com/',
    origin: 'https://aistudio.xiaomimimo.com',
    models: ['mimo'],
    selectors: {
      input: 'textarea, div[contenteditable="true"]',
      send: 'button[type="submit"], [class*="send"], [aria-label*="Send"]',
      assistantMessage: '[class*="markdown"], [class*="assistant"], [class*="message-content"]',
      reasoning: '[class*="thinking"], [class*="reasoning"]',
      generating: '[class*="stop"], [aria-label*="Stop"]',
    },
    browserType,
    headless,
  };
  return new DomProvider(cfg);
}
