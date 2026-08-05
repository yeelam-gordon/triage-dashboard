import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const html = await readFile('index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)?.[1];
if (!script) throw new Error('Inline dashboard script not found');
// HTML parsing normalizes CRLF/CR to LF before CSP hashes inline scripts.
const normalizedScript = script.replace(/\r\n?/g, '\n');
const hash = `sha256-${createHash('sha256').update(normalizedScript).digest('base64')}`;
const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
const scriptPolicy = policy.split(';').find(part => part.trim().startsWith('script-src')) || '';
if (!scriptPolicy.includes(`'${hash}'`)) {
  throw new Error(`CSP hash is stale. Replace script-src hash with '${hash}'`);
}
console.log(`CSP inline-script hash verified: ${hash}`);
