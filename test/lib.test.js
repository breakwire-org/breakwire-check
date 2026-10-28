'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../lib.js');
const fx = (p) => fs.readFileSync(path.join(__dirname, 'fixtures', p), 'utf8');

test('package.json', () => {
  const b = L.parsePackageJson(fx('npm/package.json'));
  assert.deepEqual(Object.keys(b.dependencies), ['@anthropic-ai/sdk', 'next', 'stripe']);
  assert.equal(b.devDependencies.wrangler, '^4.0.0'); assert.equal(b.engines.node, '>=20');
  assert.equal(L.parsePackageJson(fx('npm/package.json'), false).devDependencies, undefined);
});
test('requirements.txt', () => {
  assert.deepEqual(L.parseRequirements(fx('py/requirements.txt')).map((p) => `${p.name}@${p.version}`), ['anthropic@0.60.0', 'openai@1.0', 'slack_sdk@*', 'mcp@1.9', 'litellm@*']);
});
test('pyproject (PEP 621, groups, poetry)', () => {
  const names = L.parsePyproject(fx('poetry/pyproject.toml')).map((p) => `${p.name}@${p.version}`);
  assert.deepEqual(names, ['google-genai@1.0', 'openai-agents@0.24.0', 'pytest@*', 'praisonai@1', 'stripe@14.0', 'fastmcp@2.0', 'a2a-sdk@*']);
  const prod = L.parsePyproject(fx('poetry/pyproject.toml'), false).map((p) => p.name);
  assert.deepEqual(prod, ['google-genai', 'openai-agents', 'stripe', 'fastmcp']);
});
test('packagesForApi sends both spellings', () => {
  assert.deepEqual(L.packagesForApi([{ name: 'slack_sdk', version: '*' }, { name: 'openai', version: '1.0' }]), ['slack_sdk', 'slack-sdk', 'openai@1.0']);
});
test('evaluate: deadline window, advisory level, refuted skipped, past deadlines ignored', () => {
  const claims = [
    { cid: 'A', deadline: '2026-11-10', kind: 'deprecation' },
    { cid: 'B', deadline: '2027-06-01', kind: 'deprecation' },
    { cid: 'C', deadline: null, kind: 'advisory' },
    { cid: 'D', deadline: '2026-11-01', kind: 'advisory', verification: { status: 'refuted' } },
    { cid: 'E', deadline: '2026-10-01', kind: 'breaking' },
  ];
  const f = L.evaluate(claims, { days: 30, today: '2026-10-28' });
  assert.deepEqual(f.map((x) => `${x.cid}:${x.reason}:${x.level}`), ['A:deadline:fail', 'C:advisory:warn']);
  assert.equal(f[0].days_left, 13);
  assert.deepEqual(L.evaluate(claims, { days: 300, onDeadline: 'warn', onAdvisory: 'ignore', today: '2026-10-28' }).map((x) => x.cid + x.level), ['Awarn', 'Bwarn']);
});
test('version ranges and applicability', () => {
  assert.equal(L.inRange('1.9.0', '>= 1.8.0, < 1.30.0'), true);
  assert.equal(L.inRange('1.30.0', '>= 1.8.0, < 1.30.0'), false);
  assert.equal(L.inRange('1.6.77', '<= 1.6.77'), true);
  const c = { affected: ['pip:mcp >= 1.8.0, < 1.30.0', 'pip:mcp >= 2.0.0, < 2.2.0'] };
  assert.equal(L.applies(c, { eco: 'pypi', versions: { mcp: '1.20.0' } }), 'yes');
  assert.equal(L.applies(c, { eco: 'pypi', versions: { mcp: '1.31.0' } }), 'no');
  assert.equal(L.applies(c, { eco: 'pypi', versions: { mcp: null } }), 'unknown');
  assert.equal(L.applies(c, { eco: 'npm', versions: {} }), 'no', 'pip-only advisory does not apply to an npm manifest');
  assert.equal(L.applies({ affected: ['claude-sonnet-4-5-20250929'] }, { eco: 'npm', versions: {} }), 'unknown');
  assert.equal(L.applies({ affected: ['npm:@modelcontextprotocol/sdk < 1.32.0', 'esp-mcp through commit x'] }, { eco: 'pypi', versions: {} }), 'unknown');
  assert.equal(L.exactVersion('1.2.3'), '1.2.3'); assert.equal(L.exactVersion('^1.2.3'), null); assert.equal(L.exactVersion('==1.2'), '1.2');
  assert.deepEqual(L.lockVersions(JSON.stringify({ packages: { '': {}, 'node_modules/@modelcontextprotocol/sdk': { version: '1.31.0' }, 'node_modules/a/node_modules/b': { version: '9' } } })), { '@modelcontextprotocol/sdk': '1.31.0' });
});
test('evaluate uses applies: fail only when pinned version is affected', () => {
  const f = L.evaluate([{ cid: 'X', kind: 'advisory', applies: 'yes' }, { cid: 'Y', kind: 'advisory', applies: 'unknown' }, { cid: 'Z', kind: 'advisory', applies: 'no' }], { onAdvisory: 'fail', today: '2026-10-28' });
  assert.deepEqual(f.map((x) => x.cid + ':' + x.level), ['X:fail', 'Y:warn']);
});
