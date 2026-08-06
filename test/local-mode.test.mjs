import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Storage {
  #values = new Map();
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

async function component(fetchImpl = async () => { throw new Error('Unexpected fetch'); }) {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, 'dashboard inline script found');
  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    location: { href: 'https://example.test/', origin: 'https://example.test', pathname: '/', hash: '' },
    history: { replaceState() {} },
    localStorage: new Storage(),
    sessionStorage: new Storage(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Blob,
    document: {},
  });
  context.window = context;
  context.confirm = () => true;
  vm.runInContext(`${script}\nglobalThis.__dashboard = dashboard;`, context);
  return { value: context.__dashboard(), context };
}

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}

test('public mode is read-only', async () => {
  const { value } = await component(async () => response(404, {}));
  await value.detectLocalMode();
  assert.equal(value.localMode, false);
  assert.equal(value.canAct({ repo: 'microsoft/PowerToys' }), false);
});

test('same-origin local status enables operator mode', async () => {
  const { value } = await component(async (url) => {
    assert.equal(String(url), '/api/local/status');
    return response(200, {
      local: true,
      actor: { login: 'octocat', name: 'Octo' },
      csrf: 'secret',
      push_receipts: true,
    });
  });
  await value.detectLocalMode();
  assert.equal(value.localMode, true);
  assert.equal(value.localActor.login, 'octocat');
  assert.equal(value.localCsrf, 'secret');
  assert.equal(value.canAct({ repo: 'microsoft/PowerToys' }), true);
});

test('local action sends structured payload and CSRF token', async () => {
  const requests = [];
  const { value } = await component(async (url, options) => {
    requests.push({ url: String(url), options });
    return response(200, {
      ok: true,
      actor: 'octocat',
      receipt: {
        repo: 'microsoft/PowerToys',
        number: 86,
        action: 'labels',
        actor: 'octocat',
        applied_at: '2026-08-06T00:00:00Z',
        result: 'added labels',
      },
      sync: { pushed: true },
    });
  });
  value.localMode = true;
  value.localCsrf = 'csrf';
  await value.localAction({
    action: 'labels',
    repo: 'microsoft/PowerToys',
    number: 86,
    kind: 'issue',
    labels: ['Issue-Bug'],
  });
  assert.equal(requests[0].url, '/api/local/action');
  assert.equal(requests[0].options.headers['X-Triage-Token'], 'csrf');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    action: 'labels',
    repo: 'microsoft/PowerToys',
    number: 86,
    kind: 'issue',
    labels: ['Issue-Bug'],
  });
  assert.equal(value.actionReceipts['microsoft/PowerToys#86'].actor, 'octocat');
});

test('public direct write fails closed before local API call', async () => {
  let called = false;
  const { value } = await component(async () => {
    called = true;
    return response(200, {});
  });
  await value.addLabels({ repo: 'microsoft/PowerToys', number: 86 }, ['Issue-Bug']);
  assert.equal(called, false);
});

test('queued Copilot prompt is POSIX-quoted against command substitution', async () => {
  const { value } = await component();
  value.agentTaskFor = () => ({
    label: 'Fix',
    skill: '',
    branch: 'fix/test;echo BAD',
    prompt: "Fix $(touch /tmp/pwned) and `whoami`; don't expand $HOME",
  });
  const command = value.commandFor({ repo: 'microsoft/WSL', number: 1 });
  assert.match(command.command, /git checkout -b 'fix\/test;echo BAD'/);
  assert.match(command.command, /copilot -p 'Fix \$\(touch \/tmp\/pwned\) and `whoami`; don'\\''t expand \$HOME'/);
});
