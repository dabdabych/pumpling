// Launching the browser for the check suites.
//
// We take the system Chrome through playwright-core: downloading our own browser
// for a few runs makes no sense, and a build server usually has Chrome already.
// The path can be set with CHROME_PATH if it is somewhere unusual.

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

export function chromePath() {
  const found = CANDIDATES.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      'Chrome not found. Set the path in CHROME_PATH or install Google Chrome.'
    );
  }
  return found;
}

export function launch(options = {}) {
  return chromium.launch({ executablePath: chromePath(), headless: true, ...options });
}

/** The address the built frontend answers on. */
export const BASE = process.env.BASE || 'http://localhost:3200';
