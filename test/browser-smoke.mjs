import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const candidates = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = process.env.BROWSER_PATH || candidates.find(existsSync);
if (!executablePath) throw new Error('No Chrome/Edge executable found; set BROWSER_PATH');

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', error => errors.push(error.message));
await page.goto(process.env.DASHBOARD_URL || 'http://127.0.0.1:8765', { waitUntil: 'networkidle' });

const result = {
  cloaked: await page.locator('body').getAttribute('x-cloak'),
  signInText: (await page.locator('header button').last().textContent())?.trim(),
  repoVisible: await page.getByText('PowerToys', { exact: true }).count(),
  readOnlyVisible: await page.getByText('🔒 Read-only', { exact: true }).count(),
  errors,
};
console.log(JSON.stringify(result, null, 2));
await browser.close();

if (result.cloaked !== null) throw new Error('Dashboard remained cloaked');
if (!result.signInText?.includes('Sign in')) throw new Error(`Sign-in control did not render: ${result.signInText}`);
if (!result.repoVisible) throw new Error('Repository data did not render');
if (!result.readOnlyVisible) throw new Error('Anonymous read-only state did not render');
if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
