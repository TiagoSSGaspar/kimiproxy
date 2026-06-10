/*
 * File: dom/deepseek.ts
 * Project: kimiproxy
 * DeepSeek (chat.deepseek.com) DOM-driving config.
 *
 * Selectors verified against the live logged-in UI (2026-06):
 *   input   -> textarea[name="search"]  (placeholder "Message DeepSeek")
 *   send    -> .ds-button--circle.ds-button--filled
 *   answer  -> .ds-assistant-message-main-content  (last node = current reply)
 * The site streams smoothly with no class-based "stop" indicator, so completion
 * is detected by text stability (handled by the base DomProvider).
 *
 * NOTE: 'deepseek-reasoner' requires the DeepThink toggle to be enabled in the
 * UI; reasoning capture is best-effort until that toggle is automated.
 */

import { DomProvider, type DomSiteConfig } from './domProvider.ts';
import type { BrowserType } from '../../services/playwright.ts';

export function createDeepSeekProvider(
  browserType?: BrowserType,
  headless = true
): DomProvider {
  const cfg: DomSiteConfig = {
    id: 'deepseek',
    ownedBy: 'deepseek',
    loginUrl: 'https://chat.deepseek.com/',
    origin: 'https://chat.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    selectors: {
      input: 'textarea[name="search"], textarea[placeholder="Message DeepSeek"]',
      send: '.ds-button--circle.ds-button--filled',
      assistantMessage: '.ds-assistant-message-main-content',
      // Best-effort; only present in DeepThink (reasoner) mode.
      reasoning: '.ds-think-content, [class*="thinking"] .ds-markdown',
    },
    browserType,
    headless,
  };
  return new DomProvider(cfg);
}
