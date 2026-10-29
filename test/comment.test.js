'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildComment, upsertComment, MARKER } = require('../comment.js');

const claim = { cid: 'AN-2026-0001', title: 'Model X retires', url: 'https://breakwire.org/claim/AN-2026-0001', deadline: '2026-11-15', days_left: 18, fix: 'Move to model Y' };

test('comment lists claims, outcome call and AGENTS.md snippet', () => {
  const b = buildComment({ applicable: [claim], flagged: [{ ...claim, level: 'fail' }], days: 30, base: 'https://breakwire.org' });
  assert.ok(b.startsWith(MARKER));
  assert.match(b, /\[AN-2026-0001\]\(https:\/\/breakwire\.org\/claim\/AN-2026-0001\)/);
  assert.match(b, /api\/claims\/AN-2026-0001\/reports/);
  assert.match(b, /breakwire:start/);
  assert.ok(b.length < 3000);
});

test('empty comment is short', () => {
  assert.match(buildComment({ applicable: [], flagged: [], days: 30 }), /No Breakwire claims apply/);
});

function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, method: init.method, body: init.body }); const [status, data] = handler(url, init); return { status, ok: status < 300, text: async () => JSON.stringify(data) }; };
  return calls;
}
const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/ev', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: 'https://api.github.test' };
const readFile = () => JSON.stringify({ pull_request: { number: 7 } });

test('creates a comment when none exists', async () => {
  const calls = mockFetch((u, i) => i.method === 'GET' ? [200, []] : [201, { html_url: 'https://github.com/o/r/pull/7#c1' }]);
  const r = await upsertComment({ mode: 'auto', token: 't', env, readFile, body: MARKER + ' x', hasClaims: true });
  assert.strictEqual(r.action, 'created'); assert.strictEqual(calls[1].method, 'POST');
  assert.match(calls[1].url, /issues\/7\/comments$/);
});

test('updates the existing marked comment', async () => {
  const calls = mockFetch((u, i) => i.method === 'GET' ? [200, [{ id: 5, body: 'other' }, { id: 9, body: MARKER + ' old' }]] : [200, { html_url: 'u' }]);
  const r = await upsertComment({ mode: 'auto', token: 't', env, readFile, body: MARKER + ' new', hasClaims: false });
  assert.strictEqual(r.action, 'updated'); assert.strictEqual(calls[1].method, 'PATCH'); assert.match(calls[1].url, /comments\/9$/);
});

test('auto skips quietly without write permission', async () => {
  mockFetch((u, i) => i.method === 'GET' ? [200, []] : [403, { message: 'Resource not accessible by integration' }]);
  const r = await upsertComment({ mode: 'auto', token: 't', env, readFile, body: 'x', hasClaims: true });
  assert.strictEqual(r.action, 'skip'); assert.match(r.reason, /pull-requests: write/);
});

test('no comment outside pull requests, when off, or when nothing applies', async () => {
  const calls = mockFetch(() => [200, []]);
  assert.strictEqual((await upsertComment({ mode: 'auto', token: 't', env: { ...env, GITHUB_EVENT_NAME: 'push' }, readFile, body: 'x', hasClaims: true })).action, 'skip');
  assert.strictEqual((await upsertComment({ mode: 'false', token: 't', env, readFile, body: 'x', hasClaims: true })).action, 'off');
  const r = await upsertComment({ mode: 'auto', token: 't', env, readFile, body: 'x', hasClaims: false });
  assert.strictEqual(r.action, 'skip'); assert.ok(calls.every((c) => c.method === 'GET'));
});
