'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redirectAllowed, postStack } = require('../lib.js');

// fake fetch: a script of responses; records every request
function fake(script) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, ct: init.headers['content-type'] });
    const r = script[calls.length - 1] || { status: 200, body: '{"ok":true}' };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: (k) => (k.toLowerCase() === 'location' ? r.location || null : null) }, text: async () => r.body || '' };
  };
  f.calls = calls; return f;
}
const B = 'https://breakwire.org';

test('redirectAllowed: same origin and breakwire.org over https only', () => {
  assert.equal(redirectAllowed(B + '/api/stack', B + '/api/v2/stack'), true);
  assert.equal(redirectAllowed(B + '/api/stack', 'https://api.breakwire.org/x'), true);
  assert.equal(redirectAllowed('https://mirror.example.com/api/stack', 'https://mirror.example.com/y'), true);
  assert.equal(redirectAllowed('https://mirror.example.com/api/stack', 'https://breakwire.org/api/stack'), true);
  assert.equal(redirectAllowed(B + '/api/stack', 'https://evil.example/collect'), false);
  assert.equal(redirectAllowed(B + '/api/stack', 'https://breakwire.org.evil.example/'), false);
  assert.equal(redirectAllowed(B + '/api/stack', 'http://breakwire.org/api/stack'), false);
  assert.equal(redirectAllowed(B + '/api/stack', 'https://user:pw@breakwire.org/'), false);
  assert.equal(redirectAllowed(B + '/api/stack', 'https://breakwire.org:8443/'), false);
  assert.equal(redirectAllowed('http://localhost:8799/api/stack', 'http://localhost:8799/x'), true);
  assert.equal(redirectAllowed('http://localhost:8799/api/stack', 'http://localhost:9999/x'), false);
});

test('308 to breakwire.org keeps POST and body', async () => {
  const f = fake([{ status: 308, location: 'https://breakwire.org/api/stack' }, { status: 200, body: '{"applicable":[]}' }]);
  const r = await postStack('https://www.breakwire.org', { a: 1 }, { fetchImpl: f });
  assert.deepEqual(r, { applicable: [] });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].method, 'POST'); assert.equal(f.calls[1].body, '{"a":1}');
});

test('301/302/303 drop the body (GET, no content-type)', async () => {
  for (const status of [301, 302, 303]) {
    const f = fake([{ status, location: '/api/stack2' }, { status: 200, body: '{}' }]);
    await postStack(B, { secret_stack: 1 }, { fetchImpl: f });
    assert.equal(f.calls[1].method, 'GET'); assert.equal(f.calls[1].body, undefined); assert.equal(f.calls[1].ct, undefined);
  }
});

test('cross-origin redirect is refused and the body is never sent there', async () => {
  const f = fake([{ status: 307, location: 'https://evil.example/collect' }]);
  await assert.rejects(postStack(B, { a: 1 }, { fetchImpl: f }), /refusing redirect to https:\/\/evil\.example/);
  assert.equal(f.calls.length, 1);
});

test('https -> http downgrade is refused', async () => {
  const f = fake([{ status: 308, location: 'http://breakwire.org/api/stack' }]);
  await assert.rejects(postStack(B, {}, { fetchImpl: f }), /refusing redirect/);
  assert.equal(f.calls.length, 1);
});

test('at most 3 hops', async () => {
  const loop = { status: 308, location: '/api/stack' };
  const f = fake([loop, loop, loop, { status: 200, body: '{"n":3}' }]);
  assert.deepEqual(await postStack(B, {}, { fetchImpl: f }), { n: 3 });
  const g = fake([loop, loop, loop, loop, { status: 200, body: '{}' }]);
  await assert.rejects(postStack(B, {}, { fetchImpl: g }), /too many redirects/);
  assert.equal(g.calls.length, 4);
});

test('non-https base-url is refused (except localhost)', async () => {
  await assert.rejects(postStack('http://breakwire.org', {}, { fetchImpl: fake([]) }), /base-url must be https/);
  const f = fake([{ status: 200, body: '{}' }]);
  await postStack('http://localhost:8799', {}, { fetchImpl: f });
  assert.equal(f.calls[0].url, 'http://localhost:8799/api/stack');
});
