/*
 * File: providers/index.ts
 * Project: kimiproxy
 * Registers every provider and re-exports the routing helpers. Importing this
 * module has the side effect of populating the registry, so both the server
 * bootstrap and the chat route import from here.
 *
 * DOM providers are cheap to construct (no browser launches until the first
 * request), so eager registration here is safe.
 */

import type { BrowserType } from '../services/playwright.ts';
import { registerProvider } from './registry.ts';
import { KimiProvider } from './kimi/index.ts';
import { createDeepSeekProvider } from './dom/deepseek.ts';
import { createMimoProvider } from './dom/mimo.ts';

const browserType = (process.env.BROWSER as BrowserType) || 'chromium';
const domHeadless = process.env.DOM_HEADFUL ? false : true;

registerProvider(new KimiProvider());
registerProvider(createDeepSeekProvider(browserType, domHeadless));
registerProvider(createMimoProvider(browserType, domHeadless));

export { resolveModel, allModels, listProviders, getProvider } from './registry.ts';
