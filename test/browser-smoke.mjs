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
const targetUrl = process.env.DASHBOARD_URL || 'http://127.0.0.1:8765/?public=1';
const expectLocal = process.env.EXPECT_LOCAL === '1';
await page.goto(targetUrl, { waitUntil: 'networkidle' });

const result = {
  cloaked: await page.locator('body').getAttribute('x-cloak'),
  modeText: (await page.locator('header').getByText(/Public · read-only|Local · @/).first().textContent())?.trim(),
  repoVisible: await page.getByText('PowerToys', { exact: true }).count(),
  readOnlyVisible: await page.getByText('🔒 Read-only', { exact: true }).evaluateAll(elements =>
    elements.filter(element => getComputedStyle(element).display !== 'none' && element.getClientRects().length).length),
  actionVisible: await page.locator('button').evaluateAll(elements =>
    elements.filter(element => getComputedStyle(element).display !== 'none' && element.getClientRects().length && /Apply labels|Draft|Assign|Review|Close as duplicate/.test(element.textContent || '')).length),
  errors: errors.filter(error => !error.includes('status of 404')),
};
console.log(JSON.stringify(result, null, 2));
await browser.close();

if (result.cloaked !== null) throw new Error('Dashboard remained cloaked');
const expectedMode = expectLocal ? 'Local · @' : 'Public · read-only';
if (!result.modeText?.includes(expectedMode)) throw new Error(`Expected ${expectedMode}, got: ${result.modeText}`);
if (!result.repoVisible) throw new Error('Repository data did not render');
if (expectLocal && result.readOnlyVisible) throw new Error('Read-only badges remained visible in local mode');
if (!expectLocal && !result.readOnlyVisible) throw new Error('Public read-only state did not render');
if (expectLocal && !result.actionVisible) throw new Error('Local action controls did not render');
if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
