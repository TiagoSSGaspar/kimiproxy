/*
 * File: login.ts
 * Project: kimiproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Interactive manual login. Opens a visible browser for the chosen provider so
 * you can sign in once; the session is persisted to that provider's profile.
 *
 *   npm run login                 # kimi (default)
 *   npm run login -- --provider=deepseek
 *   npm run login -- --provider=qwen
 */

import { initPlaywright, closePlaywright, activePage, BrowserType } from './services/playwright.ts';
import { getProfileSession, closeAllProfiles } from './services/browser.ts';
import * as dotenv from 'dotenv';

dotenv.config();

const LOGIN_URLS: Record<string, string> = {
  kimi: 'https://www.kimi.com/',
  deepseek: 'https://chat.deepseek.com/',
  qwen: 'https://chat.qwen.ai/',
};

function parseArg(prefix: string): string | undefined {
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg ? arg.split('=')[1] : undefined;
}

async function main() {
  const browserType: BrowserType = (parseArg('--browser=') as BrowserType) || (process.env.BROWSER as BrowserType) || 'chromium';
  const provider = (parseArg('--provider=') || 'kimi').toLowerCase();

  const loginUrl = LOGIN_URLS[provider];
  if (!loginUrl) {
    console.error(`Unknown provider '${provider}'. Valid: ${Object.keys(LOGIN_URLS).join(', ')}`);
    process.exit(1);
  }

  console.log(`Opening ${browserType} to allow manual login on ${provider} (${loginUrl})...`);

  if (provider === 'kimi') {
    // Kimi keeps its dedicated context in playwright.ts (kimi_profile/).
    await initPlaywright(false, browserType);
    if (!activePage) {
      console.error('Failed to get active page');
      process.exit(1);
    }
    await activePage.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    process.on('SIGINT', async () => {
      console.log('Closing browser...');
      await closePlaywright();
      process.exit(0);
    });
  } else {
    // DOM providers use isolated profiles under profiles/<id>.
    await getProfileSession(provider, { browserType, headless: false, loginUrl });
    process.on('SIGINT', async () => {
      console.log('Closing browser...');
      await closeAllProfiles();
      process.exit(0);
    });
  }

  console.log(`Browser opened. Please log in to ${provider}.`);
  console.log('Once you can see the chat interface, close the window or press Ctrl+C here.');
}

main();
