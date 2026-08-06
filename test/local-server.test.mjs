import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRepo,
  validateNumber,
  validateText,
  validateLabels,
  validateAssignees,
  validateQueueEntry,
} from '../scripts/local-server.mjs';

test('repository actions are limited to the dashboard allowlist', () => {
  const allowlist = new Set(['microsoft/PowerToys']);
  assert.equal(validateRepo('microsoft/PowerToys', allowlist), 'microsoft/PowerToys');
  assert.throws(() => validateRepo('microsoft/WSL', allowlist), /allowlist/);
  assert.throws(() => validateRepo('../../etc/passwd', allowlist), /allowlist/);
});

test('issue numbers and text fields are bounded', () => {
  assert.equal(validateNumber('86'), 86);
  assert.throws(() => validateNumber(0), /Invalid/);
  assert.equal(validateText(' hello ', 'body'), 'hello');
  assert.throws(() => validateText('', 'body'), /Invalid/);
});

test('labels are deduplicated and assignee bots are rejected', () => {
  assert.deepEqual(validateLabels(['bug', 'bug', 'area-ui']), ['bug', 'area-ui']);
  assert.deepEqual(
    validateAssignees(['alice', '@alice', 'copilot', 'dependabot[bot]', 'area-bot']),
    ['alice'],
  );
  assert.throws(() => validateAssignees(['copilot', 'github-actions']), /No allowed/);
});

test('local queue entries are bounded and tied to an allowed repo key', () => {
  const allowlist = new Set(['microsoft/PowerToys']);
  const entry = validateQueueEntry('microsoft/PowerToys#86', {
    repo: 'microsoft/PowerToys',
    number: 86,
    url: 'https://github.com/microsoft/PowerToys/issues/86',
    kind: 'issue',
    title: 'Test',
    action: 'agent',
    label: 'Plan & fix',
    command: "copilot -p 'review issue 86'",
  }, allowlist);
  assert.equal(entry.repo, 'microsoft/PowerToys');
  assert.throws(() => validateQueueEntry('microsoft/WSL#86', {
    ...entry,
    repo: 'microsoft/WSL',
  }, allowlist), /allowlist/);
  assert.throws(() => validateQueueEntry('microsoft/PowerToys#87', entry, allowlist), /does not match/);
});
