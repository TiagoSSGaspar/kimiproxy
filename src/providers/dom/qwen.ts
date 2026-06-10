/*
 * File: dom/qwen.ts
 * Project: kimiproxy
 * Qwen (chat.qwen.ai) DOM-driving config.
 *
 * Selectors verified against the live logged-in UI (2026-06):
 *   input   -> textarea.message-input-textarea
 *   send    -> .chat-prompt-send-button (Enter also works)
 *   answer  -> .response-message-content.phase-answer  (separate from thinking)
 *   think   -> .response-message-content.phase-think
 * Auth is a JWT in localStorage (`token`/`active_token`), persisted in the
 * profile. Completion detected by text stability (base DomProvider).
 */

import { DomProvider, type DomSiteConfig } from './domProvider.ts';
import type { BrowserType } from '../../services/playwright.ts';

export function createQwenProvider(
  browserType?: BrowserType,
  headless = true
): DomProvider {
  const cfg: DomSiteConfig = {
    id: 'qwen',
    ownedBy: 'alibaba',
    loginUrl: 'https://chat.qwen.ai/',
    origin: 'https://chat.qwen.ai',
    models: ['qwen3-max', 'qwen-plus'],
    selectors: {
      input: 'textarea.message-input-textarea',
      send: '.chat-prompt-send-button, .message-input-right-button-send, button.send-button',
      assistantMessage: '.response-message-content.phase-answer',
      reasoning: '.response-message-content.phase-think',
    },
    // Qwen applies its localStorage JWT during hydration; wait before sending.
    settleMs: 5000,
    browserType,
    headless,
  };
  return new DomProvider(cfg);
}
