import { createServer as createHttpServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { resolve, relative, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const root = resolve(process.cwd());
const localConfigPath = join(root, 'local-config.json');
const defaultConfig = { port: 43129, push_receipts: true, allowed_repos: [] };
const config = existsSync(localConfigPath)
  ? { ...defaultConfig, ...JSON.parse(await readFile(localConfigPath, 'utf8')) }
  : defaultConfig;
const host = '127.0.0.1';
const port = Number(process.env.TRIAGE_PORT || config.port || 43129);
const origin = `http://${host}:${port}`;
const csrf = randomBytes(32).toString('base64url');
const execOptions = { windowsHide: true, maxBuffer: 10 * 1024 * 1024 };
let gitQueue = Promise.resolve();

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(value));
}

async function gh(args) {
  const { stdout } = await exec('gh', args, execOptions);
  return stdout.trim();
}

async function actor() {
  return JSON.parse(await gh(['api', 'user', '--jq', '{login:.login,name:(.name // "")}']));
}

async function trackedRepos() {
  const repos = (config.allowed_repos || []).map(String);
  if (!repos.length) throw new Error('local-config.json must define allowed_repos');
  return new Set(repos);
}

export function validateRepo(repo, allowlist) {
  const value = String(repo || '');
  if (!allowlist.has(value) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('Repository is not in the dashboard allowlist');
  }
  return value;
}

export function validateNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid issue/PR number');
  return number;
}

export function validateText(value, name, max = 10000) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new Error(`Invalid ${name}`);
  return text;
}

export function validateLabels(values) {
  const labels = [...new Set((values || []).map(value => validateText(value, 'label', 100)))].slice(0, 10);
  if (!labels.length) throw new Error('No labels supplied');
  return labels;
}

export function validateAssignees(values) {
  const blocked = /(?:\[bot\]$|(?:^|[-_])bot$|^copilot$|^github-actions$|^dependabot$)/i;
  const assignees = [...new Set((values || [])
    .map(value => String(value || '').trim().replace(/^@/, ''))
    .filter(value => /^[A-Za-z0-9-]{1,39}$/.test(value) && !blocked.test(value)))].slice(0, 10);
  if (!assignees.length) throw new Error('No allowed assignees supplied');
  return assignees;
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 25000) throw new Error('Request too large');
  }
  return JSON.parse(text || '{}');
}

async function recordReceipt(payload, result, user) {
  const dir = join(root, 'data', 'actions');
  const path = join(dir, 'latest.json');
  await mkdir(dir, { recursive: true });
  let document = { generated_at: '', items: {} };
  try { document = JSON.parse(await readFile(path, 'utf8')); } catch {}
  const key = `${payload.repo}#${payload.number}`;
  document.generated_at = new Date().toISOString();
  document.items[key] = {
    repo: payload.repo,
    number: payload.number,
    action: payload.action,
    actor: user.login,
    applied_at: document.generated_at,
    result,
  };
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(document, null, 2) + '\n');
  await rename(temp, path);
  return document.items[key];
}

async function pushReceiptsUnlocked(receipt) {
  if (!config.push_receipts) return { pushed: false };
  const { stdout: branch } = await exec('git', ['branch', '--show-current'], { cwd: root, ...execOptions });
  if (branch.trim() !== 'main') throw new Error(`Receipt pushes require main branch (current: ${branch.trim()})`);
  const { stdout: stagedBefore } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: root, ...execOptions });
  const unrelated = stagedBefore.split(/\r?\n/).filter(Boolean).filter(path => path !== 'data/actions/latest.json');
  if (unrelated.length) throw new Error(`Refusing to commit pre-staged files: ${unrelated.join(', ')}`);
  const message = `actions: ${receipt.action} ${receipt.repo}#${receipt.number} by @${receipt.actor}`;
  await exec('git', ['add', 'data/actions/latest.json'], { cwd: root, ...execOptions });
  try {
    await exec('git', ['diff', '--cached', '--quiet'], { cwd: root, ...execOptions });
    return { pushed: false };
  } catch {}
  await exec('git', [
    '-c', 'user.name=triage-local',
    '-c', 'user.email=triage-local@localhost',
    'commit', '-m', message, '--', 'data/actions/latest.json',
  ], { cwd: root, ...execOptions });
  await exec('git', ['push', 'origin', 'HEAD:main'], { cwd: root, ...execOptions });
  return { pushed: true };
}

function withGitLock(task) {
  const operation = gitQueue.then(task, task);
  gitQueue = operation.catch(() => {});
  return operation;
}

async function syncFromRemote() {
  return withGitLock(async () => {
    try {
      const { stdout } = await exec('git', ['pull', '--rebase', '--autostash'], { cwd: root, ...execOptions });
      return { ok: true, output: stdout.trim() };
    } catch (error) {
      try { await exec('git', ['rebase', '--abort'], { cwd: root, ...execOptions }); } catch {}
      throw error;
    }
  });
}

async function applyAction(payload) {
  const allowlist = await trackedRepos();
  const repo = validateRepo(payload.repo, allowlist);
  const number = validateNumber(payload.number);
  const kind = payload.kind === 'pr' ? 'pr' : 'issue';
  const user = await actor();
  if (config.push_receipts) await syncFromRemote();
  let result;

  switch (payload.action) {
    case 'comment': {
      const body = validateText(payload.body, 'comment');
      await gh([kind, 'comment', String(number), '--repo', repo, '--body', body]);
      result = 'comment posted';
      break;
    }
    case 'labels': {
      const labels = validateLabels(payload.labels);
      const args = [kind, 'edit', String(number), '--repo', repo];
      for (const label of labels) args.push('--add-label', label);
      await gh(args);
      result = `added labels: ${labels.join(', ')}`;
      break;
    }
    case 'assign': {
      const assignees = validateAssignees(payload.assignees);
      const args = [kind, 'edit', String(number), '--repo', repo];
      for (const assignee of assignees) args.push('--add-assignee', assignee);
      await gh(args);
      result = `assigned: ${assignees.map(value => '@' + value).join(', ')}`;
      break;
    }
    case 'close_duplicate': {
      if (kind !== 'issue') throw new Error('Only issues can be closed as duplicate');
      const body = validateText(payload.body, 'duplicate comment');
      await gh(['issue', 'comment', String(number), '--repo', repo, '--body', body]);
      await gh(['issue', 'close', String(number), '--repo', repo, '--reason', 'not planned']);
      result = 'commented and closed as duplicate';
      break;
    }
    case 'pr_review': {
      if (kind !== 'pr') throw new Error('Review action requires a PR');
      const event = String(payload.event || '').toUpperCase();
      if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(event)) throw new Error('Invalid review event');
      const args = ['pr', 'review', String(number), '--repo', repo];
      if (event === 'APPROVE') args.push('--approve');
      if (event === 'REQUEST_CHANGES') args.push('--request-changes');
      if (event === 'COMMENT') args.push('--comment');
      const body = String(payload.body || '').trim();
      if (event === 'REQUEST_CHANGES' && !body) throw new Error('Request changes requires a comment');
      if (body) args.push('--body', body.slice(0, 10000));
      await gh(args);
      result = `PR review submitted: ${event}`;
      break;
    }
    case 'workflow': {
      const workflow = validateText(payload.workflow, 'workflow', 200);
      if (!/^[A-Za-z0-9_.-]+$/.test(workflow)) throw new Error('Invalid workflow name');
      const ref = validateText(payload.ref || 'main', 'ref', 200);
      const args = ['workflow', 'run', workflow, '--repo', repo, '--ref', ref];
      for (const [key, value] of Object.entries(payload.inputs || {})) {
        if (!/^[A-Za-z0-9_-]{1,50}$/.test(key)) throw new Error('Invalid workflow input');
        args.push('-f', `${key}=${String(value).slice(0, 500)}`);
      }
      await gh(args);
      result = `workflow dispatched: ${workflow}`;
      break;
    }
    default:
      throw new Error('Unsupported action');
  }

  let receipt = {
    repo,
    number,
    action: payload.action,
    actor: user.login,
    applied_at: new Date().toISOString(),
    result,
  };
  let sync = { pushed: false };
  try {
    await withGitLock(async () => {
      receipt = await recordReceipt({ ...payload, repo, number }, result, user);
      try { sync = await pushReceiptsUnlocked(receipt); } catch (error) {
        sync = { pushed: false, error: `Action succeeded but receipt push failed: ${error.message}` };
      }
    });
  } catch (error) {
    sync = { pushed: false, error: `Action succeeded but receipt write failed: ${error.message}` };
  }
  return { ok: true, actor: user.login, receipt, sync };
}

async function serveFile(req, res, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel.includes('.git') || rel.startsWith('node_modules') || relativePath === 'local-config.json') {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('Not a file');
    const content = await readFile(target);
    res.writeHead(200, {
      'Content-Type': mime[extname(target)] || 'application/octet-stream',
      'Cache-Control': relativePath.startsWith('data/') ? 'no-store' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = createHttpServer(async (req, res) => {
  try {
    const remote = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      return json(res, 403, { error: 'Loopback clients only' });
    }
    if (req.headers.host !== `${host}:${port}`) return json(res, 403, { error: 'Invalid host' });
    const url = new URL(req.url, origin);
    if (url.pathname === '/api/local/status' && req.method === 'GET') {
      const user = await actor();
      return json(res, 200, {
        local: true,
        actor: user,
        csrf,
        push_receipts: !!config.push_receipts,
      });
    }
    if (url.pathname === '/api/local/action' && req.method === 'POST') {
      if (req.headers.origin !== origin) return json(res, 403, { error: 'Invalid origin' });
      if (req.headers['x-triage-token'] !== csrf) return json(res, 403, { error: 'Invalid local token' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return json(res, 415, { error: 'JSON required' });
      }
      const payload = await readBody(req);
      return json(res, 200, await applyAction(payload));
    }
    if (url.pathname === '/api/local/sync' && req.method === 'POST') {
      if (req.headers.origin !== origin) return json(res, 403, { error: 'Invalid origin' });
      if (req.headers['x-triage-token'] !== csrf) return json(res, 403, { error: 'Invalid local token' });
      return json(res, 200, await syncFromRemote());
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    return serveFile(req, res, url.pathname);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  server.listen(port, host, () => {
    console.log(`Triage Dashboard local operator mode: ${origin}/`);
    console.log('Actions use the account shown by: gh auth status');
  });
}
