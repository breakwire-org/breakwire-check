'use strict';
// Pure helpers (no I/O): manifest parsing and evaluation. Unit-tested offline.

function parsePackageJson(text, includeDev = true) {
  const j = JSON.parse(text);
  const out = { dependencies: { ...(j.dependencies || {}), ...(j.optionalDependencies || {}), ...(j.peerDependencies || {}) } };
  if (includeDev && j.devDependencies) out.devDependencies = { ...j.devDependencies };
  if (j.engines && j.engines.node) out.engines = { node: String(j.engines.node) };
  return out;
}

// "name[extra]==1.2 ; python_version>'3'" -> "name@1.2" ; returns null for non-package lines
function pep508ToPackage(spec) {
  const s = String(spec).split(';')[0].split('#')[0].trim();
  if (!s || s.startsWith('-') || /^(git\+|https?:|file:|\.|\/)/.test(s)) return null;
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(?:@\s*\S+|(===?|~=|!=|<=|>=|<|>)\s*([^,\s]+))?/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return { name, version: m[4] ? m[4].replace(/\.\*$/, '') : '*', exact: (m[3] === '==' || m[3] === '===') && !/\*/.test(m[4] || '') };
}

function parseRequirements(text) {
  const pkgs = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const p = pep508ToPackage(line);
    if (p) pkgs.push(p);
  }
  return pkgs;
}

// Minimal TOML reader for the parts we need: [project] dependencies / optional-dependencies,
// [dependency-groups], [tool.poetry.dependencies] and [tool.poetry.group.<x>.dependencies].
function parsePyproject(text, includeDev = true) {
  const lines = text.split(/\r?\n/);
  const pkgs = [];
  let table = '';
  const strings = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/^\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const t = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (t) { table = t[1]; continue; }
    const kv = line.match(/^("?[A-Za-z0-9_.-]+"?)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    let val = kv[2];
    const takeArray = () => { let acc = val; let depth = (acc.match(/\[/g) || []).length - (acc.match(/\]/g) || []).length; while (depth > 0 && i + 1 < lines.length) { i++; const l = lines[i].replace(/#.*$/, ''); acc += '\n' + l; depth += (l.match(/\[/g) || []).length - (l.match(/\]/g) || []).length; } return acc; };
    const isDevGroup = (name) => /^(dev|test|tests|lint|docs|typing)$/i.test(name);
    if (table === 'project' && key === 'dependencies') { for (const s of strings(takeArray())) { const p = pep508ToPackage(s); if (p) pkgs.push(p); } continue; }
    if (table === 'project.optional-dependencies') { const arr = takeArray(); if (includeDev || !isDevGroup(key)) for (const s of strings(arr)) { const p = pep508ToPackage(s); if (p) pkgs.push(p); } continue; }
    if (table === 'dependency-groups') { const arr = takeArray(); if (includeDev || !isDevGroup(key)) for (const s of strings(arr)) { const p = pep508ToPackage(s); if (p) pkgs.push(p); } continue; }
    const poetryMain = table === 'tool.poetry.dependencies';
    const poetryGroup = table.match(/^tool\.poetry\.(?:group\.([^.]+)\.)?dev-dependencies$|^tool\.poetry\.group\.([^.]+)\.dependencies$/);
    if (poetryMain || (poetryGroup && includeDev)) {
      if (key.toLowerCase() === 'python') continue;
      let version = '*';
      const str = val.match(/^["']([^"']*)["']/);
      if (str) version = str[1];
      else { const vm = val.match(/version\s*=\s*["']([^"']*)["']/); if (vm) version = vm[1]; }
      pkgs.push({ name: key.toLowerCase(), version: version.replace(/^[\^~>=<!\s]+/, '').split(',')[0].trim() || '*', exact: /^\d+(\.\d+)*$/.test(version.trim()) });
    }
  }
  return pkgs;
}

// Send both _ and - spellings: the API's package map uses each in places (slack_sdk, google-genai).
function packagesForApi(pkgs) {
  const out = new Set();
  for (const p of pkgs) {
    const v = p.version && p.version !== '*' ? p.version : '';
    for (const n of new Set([p.name, p.name.replace(/_/g, '-'), p.name.replace(/-/g, '_')])) out.add(v ? `${n}@${v}` : n);
  }
  return [...out].slice(0, 200);
}

function daysUntil(dateStr, today) {
  const d = Date.parse(dateStr + 'T00:00:00Z'), t = Date.parse(today + 'T00:00:00Z');
  return Math.round((d - t) / 86400000);
}

// claims: /api/stack applicable[]; returns flagged list with level fail|warn
// v1.2.0: a deadline blocks only when it is tied to something you actually use: a package/version, runtime or model match
// (match.by package|runtime|model, or bucket exactly_applies/may_apply). A claim matched by service name alone (e.g. a model
// retirement found because you depend on that vendor's SDK) is an advisory warning unless deadline-policy is "any".
function matchBasis(c) {
  if (!c.match) return 'legacy';
  if (['package', 'runtime', 'model'].includes(c.match.by) || c.bucket === 'exactly_applies' || c.bucket === 'may_apply') return c.match.by || c.bucket;
  return 'service-only';
}
function evaluate(claims, { days = 30, onDeadline = 'fail', onAdvisory = 'warn', deadlinePolicy = 'specific', today = new Date().toISOString().slice(0, 10) } = {}) {
  const flagged = [];
  for (const c of claims || []) {
    if (c.verification && c.verification.status === 'refuted') continue;
    if (c.applies === 'no') continue;
    const due = (c.next_deadline && c.next_deadline.date) || c.deadline;
    if (due && onDeadline !== 'ignore') {
      const n = daysUntil(due, today);
      if (n >= 0 && n <= days) {
        const basis = matchBasis(c), specific = basis !== 'service-only' || deadlinePolicy === 'any';
        flagged.push({ ...c, reason: 'deadline', due, days_left: n, match_basis: basis, level: specific ? onDeadline : (onDeadline === 'fail' ? 'warn' : onDeadline) });
        continue;
      }
    }
    // Advisories fail only when a pinned/locked version is inside an affected range; otherwise they warn.
    if (c.kind === 'advisory' && onAdvisory !== 'ignore') flagged.push({ ...c, reason: 'advisory', level: c.applies === 'yes' ? onAdvisory : (onAdvisory === 'fail' ? 'warn' : onAdvisory) });
  }
  return flagged;
}

// ---- version-aware filtering of affected[] entries like "npm:@modelcontextprotocol/sdk >= 1.10.0, < 1.30.1" / "pip:mcp < 1.30.0"
const ECO = { npm: 'npm', pip: 'pypi', pypi: 'pypi' };
function cmpVersion(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? +x : NaN)), pb = String(b).split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? +x : NaN));
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (isNaN(x) || isNaN(y)) return 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
function inRange(version, rangeText) {
  const parts = String(rangeText).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return true;
  for (const p of parts) {
    const m = p.match(/^(<=|>=|<|>|==|=)?\s*v?(\d+(?:\.\d+)*)/);
    if (!m) return null; // cannot evaluate
    const c = cmpVersion(version, m[2]), op = m[1] || '==';
    if (!((op === '<' && c < 0) || (op === '<=' && c <= 0) || (op === '>' && c > 0) || (op === '>=' && c >= 0) || ((op === '==' || op === '=') && c === 0))) return false;
  }
  return true;
}
function parseAffected(entry) {
  const m = String(entry).match(/^(npm|pip|pypi):\s*(@?[A-Za-z0-9._\/-]+)\s*(.*)$/i);
  return m ? { eco: ECO[m[1].toLowerCase()], name: m[2].toLowerCase(), range: m[3].trim() } : null;
}
const norm = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');
// Exact version if the spec is a pin ("1.2.3", "==1.2.3", "=1.2.3"), else null.
function exactVersion(spec) { const m = String(spec || '').trim().match(/^(?:==|=)?\s*v?(\d+\.\d+(?:\.\d+)?)$/); return m ? m[1] : null; }

/**
 * applies(claim, manifest) -> 'yes' | 'no' | 'unknown'
 * manifest: { eco: 'npm'|'pypi', versions: { name: exactVersion|null } }
 * 'no' only when every ecosystem-tagged affected entry is for the other ecosystem, or the package is pinned
 * (lockfile or ==) to a version outside every listed range.
 */
function applies(claim, manifest) {
  const entries = (claim.affected || []).map(parseAffected).filter(Boolean);
  if (!entries.length || !manifest) return 'unknown';
  const mine = entries.filter((e) => e.eco === manifest.eco);
  if (!mine.length) return (claim.affected || []).length === entries.length ? 'no' : 'unknown';
  let sawPinned = false;
  for (const e of mine) {
    const key = Object.keys(manifest.versions).find((k) => norm(k) === norm(e.name));
    if (!key) continue;
    const v = manifest.versions[key];
    if (!v) return 'unknown';
    sawPinned = true;
    const r = inRange(v, e.range);
    if (r === null) return 'unknown';
    if (r) return 'yes';
  }
  return sawPinned ? 'no' : 'unknown';
}

// package-lock.json v2/v3 -> { name: version } for top-level deps
function lockVersions(lockText) {
  try { const j = JSON.parse(lockText); const out = {}; for (const [k, v] of Object.entries(j.packages || {})) { const m = k.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)$/); if (m && v && v.version) out[m[1]] = v.version; } for (const [k, v] of Object.entries(j.dependencies || {})) if (!out[k] && v && v.version) out[k] = v.version; return out; } catch { return {}; }
}

// 1.2.0: redirect policy for the stack POST. Follow only https redirects to the same origin as base-url or to breakwire.org
// (and its subdomains), at most 3 hops; keep the method and body only on 307/308 (301/302/303 become a bodiless GET, as in
// browsers). http is allowed only for a same-origin loopback base-url (local testing). Anything else throws.
const MAX_REDIRECTS = 3;
function redirectAllowed(base, target) {
  let b, t;
  try { b = new URL(base); t = new URL(target); } catch { return false; }
  const loop = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  if (t.username || t.password) return false;
  if (t.protocol !== 'https:' && !(t.protocol === 'http:' && t.origin === b.origin && loop(t.hostname))) return false;
  if (t.origin === b.origin) return true;
  return t.protocol === 'https:' && (t.hostname === 'breakwire.org' || t.hostname.endsWith('.breakwire.org')) && (t.port === '' || t.port === '443');
}
async function postStack(base, body, { timeoutMs = 30000, fetchImpl = fetch, version = '0' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const start = String(base).replace(/\/+$/, '') + '/api/stack';
    if (!redirectAllowed(start, start)) throw new Error(`base-url must be https (http only for localhost): ${new URL(start).origin}`);
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `breakwire-check/${version} (+github-action)`, 'x-breakwire-client': `breakwire-action/${version}` };
    let url = start, method = 'POST', payload = JSON.stringify(body);
    let res = await fetchImpl(url, { method, headers, body: payload, signal: ctrl.signal, redirect: 'manual' });
    for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
      const loc = res.headers.get('location');
      if (!loc) break;
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
      const next = new URL(loc, url).toString();
      if (!redirectAllowed(start, next)) throw new Error(`refusing redirect to ${new URL(next).origin} (only same-origin or breakwire.org over https)`);
      if (![307, 308].includes(res.status)) { method = 'GET'; payload = undefined; }
      url = next;
      const h = { ...headers }; if (!payload) delete h['content-type'];
      res = await fetchImpl(url, { method, headers: h, ...(payload ? { body: payload } : {}), signal: ctrl.signal, redirect: 'manual' });
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

module.exports = { redirectAllowed, postStack, MAX_REDIRECTS, matchBasis, applies, inRange, cmpVersion, parseAffected, exactVersion, lockVersions, norm, parsePackageJson, parseRequirements, parsePyproject, pep508ToPackage, packagesForApi, evaluate, daysUntil };
