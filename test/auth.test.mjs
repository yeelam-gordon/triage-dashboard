import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

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
  const location = {
    href: 'https://yeelam-gordon.github.io/triage-dashboard/',
    origin: 'https://yeelam-gordon.github.io',
    pathname: '/triage-dashboard/',
    hash: '',
    assign() {},
  };
  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    Uint8Array,
    crypto: webcrypto,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    fetch: fetchImpl,
    location,
    history: { replaceState() {} },
    localStorage: new Storage(),
    sessionStorage: new Storage(),
    setTimeout,
    clearTimeout,
    Blob,
    document: {},
  });
  context.window = context;
  context.confirm = () => true;
  vm.runInContext(`${script}\nglobalThis.__dashboard = dashboard;`, context);
  return { value: context.__dashboard(), context, location };
}

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}

test('anonymous and unauthorized users are read-only', async () => {
  const { value } = await component();
  assert.equal(value.isAuthorized, false);
  assert.equal(value.canAct({ repo: 'microsoft/PowerToys' }), false);
  value.authUser = { login: 'reader' };
  assert.equal(value.canAct({ repo: 'microsoft/PowerToys' }), false);
});

test('signIn starts PKCE flow without a client secret', async () => {
  const { value, context, location } = await component();
  let target = '';
  location.assign = value => { target = value; };
  value.oauthClientId = 'Iv1.public-client';
  value.oauthCallbackUrl = 'https://yeelam-gordon.github.io/triage-dashboard/';
  await value.signIn();
  const url = new URL(target);
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'Iv1.public-client');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.ok(context.sessionStorage.getItem('triage_oauth_verifier'));
  assert.equal(url.searchParams.get('state'), context.sessionStorage.getItem('triage_oauth_state'));
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('team policy grants only mapped repositories', async () => {
  const calls = [];
  const { value } = await component(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/user')) return response(200, { login: 'octocat', avatar_url: 'x', name: 'Octo' });
    if (String(url).includes('/teams/terminalacore/')) return response(200, { state: 'active' });
    if (String(url).includes('/teams/powertoys-stca/')) return response(404, { message: 'Not Found' });
    throw new Error(`Unexpected ${url}`);
  });
  value.token = 'ghu_test';
  value.tokenExpiresAt = Date.now() + 120000;
  value.authPolicy = {
    organization: 'microsoft',
    teams: [
      { slug: 'terminalacore', repos: ['microsoft/intelligent-terminal', 'microsoft/WSL'] },
      { slug: 'powertoys-stca', repos: ['microsoft/PowerToys'] },
    ],
  };
  await value.loadAuthorizedUser(false);
  assert.deepEqual([...value.authorizedRepos], ['microsoft/intelligent-terminal', 'microsoft/WSL']);
  assert.equal(value.canAct({ repo: 'microsoft/WSL' }), true);
  assert.equal(value.canAct({ repo: 'microsoft/PowerToys' }), false);
  assert.equal(calls.length, 3);
});

test('direct label action uses the signed-in user token', async () => {
  const requests = [];
  const { value } = await component(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return response(200, []);
  });
  value.token = 'ghu_user';
  value.tokenExpiresAt = Date.now() + 120000;
  value.authUser = { login: 'octocat' };
  value.authorizedRepos = ['microsoft/PowerToys'];
  value.loadAuthorizedUser = async () => {};
  await value.addLabels(
    { repo: 'microsoft/PowerToys', number: 86, suggested_labels: ['Issue-Bug'] },
    ['Issue-Bug'],
  );
  assert.equal(requests[0].url, 'https://api.github.com/repos/microsoft/PowerToys/issues/86/labels');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer ghu_user');
  assert.deepEqual(JSON.parse(requests[0].options.body), { labels: ['Issue-Bug'] });
});

test('unauthorized direct write fails closed before GitHub API call', async () => {
  let called = false;
  const { value } = await component(async () => {
    called = true;
    return response(200, {});
  });
  value.authUser = { login: 'reader' };
  value.authorizedRepos = [];
  await value.addLabels({ repo: 'microsoft/PowerToys', number: 86 }, ['Issue-Bug']);
  assert.equal(called, false);
});

test('PR approval is submitted with the signed-in user token', async () => {
  const requests = [];
  const { value } = await component(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return response(200, { id: 1 });
  });
  value.token = 'ghu_reviewer';
  value.tokenExpiresAt = Date.now() + 120000;
  value.authUser = { login: 'reviewer' };
  value.authorizedRepos = ['microsoft/PowerToys'];
  value.loadAuthorizedUser = async () => {};
  value.reviewModal = {
    open: true,
    issue: { repo: 'microsoft/PowerToys', number: 86, kind: 'pr' },
    skill: '',
    body: 'Looks good.',
  };
  await value.submitPrReview('APPROVE');
  assert.equal(requests[0].url, 'https://api.github.com/repos/microsoft/PowerToys/pulls/86/reviews');
  assert.deepEqual(JSON.parse(requests[0].options.body), { event: 'APPROVE', body: 'Looks good.' });
});

test('PRs needing review open direct review controls without workflow capability', async () => {
  const { value } = await component();
  const pr = { repo: 'microsoft/PowerToys', number: 86, kind: 'pr' };
  value.authUser = { login: 'reviewer' };
  value.authorizedRepos = ['microsoft/PowerToys'];
  value.stateOf = () => ({ key: 'needs_review' });
  value.canRunAgentReview = () => false;
  value.primaryAction(pr);
  assert.equal(value.reviewModal.open, true);
  assert.equal(value.reviewModal.issue.number, 86);
});

test('model-suggested bot assignees are rejected', async () => {
  const { value } = await component();
  assert.deepEqual(
    [...value.assigneeHandles({
      owner_kind: 'assignee',
      suggested_owner: 'alice, @copilot, dependabot[bot], github-actions, area-bot',
    })],
    ['alice'],
  );
});

test('OAuth callback exchanges with PKCE and grants mapped team repos', async () => {
  const { value, context, location } = await component(async (url) => {
    const href = String(url);
    if (href === 'https://github.com/login/oauth/access_token') {
      return response(200, { access_token: 'ghu_login', refresh_token: 'ghr_refresh', expires_in: 28800 });
    }
    if (href.endsWith('/user')) return response(200, { login: 'octocat', avatar_url: 'x', name: 'Octo' });
    if (href.includes('/teams/terminalacore/')) return response(200, { state: 'active' });
    return response(404, { message: 'Not Found' });
  });

  value.oauthClientId = 'Iv1.test';
  value.oauthCallbackUrl = 'https://yeelam-gordon.github.io/triage-dashboard/';
  value.authPolicy = {
    organization: 'microsoft',
    teams: [{ slug: 'terminalacore', repos: ['microsoft/WSL'] }],
  };
  context.sessionStorage.setItem('triage_oauth_state', 'expected');
  context.sessionStorage.setItem('triage_oauth_verifier', 'verifier');
  location.href = 'https://yeelam-gordon.github.io/triage-dashboard/?code=abc&state=expected';
  await value.completeOAuthLogin();
  assert.equal(value.token, 'ghu_login');
  assert.equal(value.refreshToken, 'ghr_refresh');
  assert.equal(value.authUser.login, 'octocat');
  assert.deepEqual([...value.authorizedRepos], ['microsoft/WSL']);
  assert.equal(context.localStorage.getItem('gh_token'), null);
});

test('concurrent expiry checks share one refresh-token exchange', async () => {
  let exchanges = 0;
  const { value } = await component(async (url) => {
    if (String(url) !== 'https://github.com/login/oauth/access_token') throw new Error(`Unexpected ${url}`);
    exchanges++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return response(200, { access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800 });
  });
  value.oauthClientId = 'Iv1.test';
  value.token = 'ghu_old';
  value.refreshToken = 'ghr_old';
  value.tokenExpiresAt = Date.now();
  await Promise.all([value.ensureToken(), value.ensureToken(), value.ensureToken()]);
  assert.equal(exchanges, 1);
  assert.equal(value.token, 'ghu_new');
  assert.equal(value.refreshToken, 'ghr_new');
});

test('sign-out prevents an in-flight refresh from restoring tokens', async () => {
  let resolveExchange;
  const exchange = new Promise(resolve => { resolveExchange = resolve; });
  const { value } = await component(async (url) => {
    if (String(url) !== 'https://github.com/login/oauth/access_token') throw new Error(`Unexpected ${url}`);
    await exchange;
    return response(200, { access_token: 'ghu_resurrected', refresh_token: 'ghr_resurrected', expires_in: 28800 });
  });
  value.oauthClientId = 'Iv1.test';
  value.token = 'ghu_old';
  value.refreshToken = 'ghr_old';
  value.tokenExpiresAt = Date.now();
  const pending = value.ensureToken();
  value.clearToken(false);
  resolveExchange();
  await assert.rejects(pending, /Authentication changed/);
  assert.equal(value.token, '');
  assert.equal(value.refreshToken, '');
  assert.equal(value.authUser, null);
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
