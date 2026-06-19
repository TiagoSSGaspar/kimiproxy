/*
 * File: dom/zai.ts
 * Project: kimiproxy
 * Z.ai (chat.z.ai) DOM-driving config — Zhipu's GLM chat.
 *
 * API replay is NOT viable here: z.ai signs each generation request
 * (`POST /api/v2/chat/completions`) with a client-side `x-signature` + a
 * `captcha_verify_param`, both produced by the front-end's anti-bot JS. So we
 * drive the DOM and let the page build the signed/captcha'd request itself.
 *
 * Selectors verified against the live logged-in UI (2026-06):
 *   input   -> textarea#chat-input            (placeholder "Send a Message")
 *   send    -> #send-message-button           (Enter also works, used as fallback)
 *   answer  -> .chat-assistant                (last node = current reply; user is .chat-user)
 *   think   -> .thinking-chain-container       (inline collapsible; also stripped from answer)
 * Auth is a JWT in localStorage, persisted in the profile. Completion detected
 * by text stability (base DomProvider).
 *
 * NOTE: DOM driving uses whatever model is currently selected in the UI; the
 * model list below is for /v1/models discovery and does not switch the UI model.
 */

import { DomProvider, type DomSiteConfig } from './domProvider.ts';
import type { BrowserType } from '../../services/playwright.ts';

export function createZaiProvider(
  browserType?: BrowserType,
  headless = true
): DomProvider {
  const cfg: DomSiteConfig = {
    id: 'zai',
    ownedBy: 'zhipu',
    loginUrl: 'https://chat.z.ai/',
    origin: 'https://chat.z.ai',
    models: ['GLM-5-Turbo', 'glm-5.2', 'GLM-5.1', 'glm-4.7'],
    selectors: {
      input: 'textarea#chat-input',
      send: '#send-message-button, button[aria-label*="Send"], button[type="submit"]',
      assistantMessage: '.chat-assistant',
      // GLM renders its reasoning in an inline collapsible ("Thought Process").
      // Capture it as reasoning AND strip it from the answer text.
      reasoning: '.thinking-chain-container',
      exclude: '.thinking-chain-container',
    },
    // The SPA applies its localStorage JWT during hydration; wait before sending.
    settleMs: 5000,
    browserType,
    headless,
  };
  return new DomProvider(cfg);
}
