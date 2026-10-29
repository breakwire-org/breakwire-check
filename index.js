'use strict';
// breakwire-check: zero-dependency GitHub Action (node24). Reads manifests, calls POST /api/stack, flags deadlines/advisories.
const fs = require('fs');
const path = require('path');
const { parsePackageJson, parseRequirements, parsePyproject, packagesForApi, evaluate, applies, exactVersion, lockVersions, norm } = require('./lib.js');

const VERSION = '1.1.0';
const { buildComment, upsertComment } = require('./comment.js');
const input = (name, def = '') => { const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`]; return v === undefined || v === '' ? def : v.trim(); };
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const annotate = (level, msg, file) => console.log(`::${level}${file ? ` file=${escProp(file)}` : ''}::${esc(msg)}`);
const appendFile = (envName, text) => { const f = process.env[envName]; if (f) fs.appendFileSync(f, text); };
const setOutput = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFile('GITHUB_OUTPUT', `${k}=${v}\n`); else console.log(`output ${k}=${v}`); };

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'env', '.tox', 'dist', 'build', '__pycache__', '.next', 'vendor', 'site-packages']);
function findManifests(root, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) findManifests(p, depth + 1, out); }
    else if (e.name === 'package.json' || e.name === 'pyproject.toml' || /^requirements.*\.txt$/.test(e.name)) out.push(p);
  }
  return out;
}

async function post(base, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let url = base.replace(/\/+$/, '') + '/api/stack';
    const init = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `breakwire-check/${VERSION} (+github-action)` }, body: JSON.stringify(body), signal: ctrl.signal, redirect: 'manual' };
    let res = await fetch(url, init);
    for (let i = 0; i < 2 && res.status >= 301 && res.status <= 308 && res.headers.get('location'); i++) { url = new URL(res.headers.get('location'), url).toString(); res = await fetch(url, init); }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

async function main() {
  const root = input('path', '.');
  const explicit = input('files').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const days = parseInt(input('days', '30'), 10);
  const onDeadline = input('on-deadline', 'fail');
  const onAdvisory = input('on-advisory', 'fail');
  const includeDev = input('include-dev', 'true') !== 'false';
  const base = input('base-url', 'https://breakwire.org');
  const failOnApiError = input('fail-on-api-error', 'false') === 'true';
  const timeoutMs = parseInt(input('timeout-seconds', '20'), 10) * 1000;
  for (const [k, v] of [['on-deadline', onDeadline], ['on-advisory', onAdvisory]]) if (!['fail', 'warn', 'ignore'].includes(v)) throw new Error(`${k} must be fail|warn|ignore, got ${v}`);

  const files = explicit.length ? explicit : findManifests(root);
  if (!files.length) { annotate('notice', `breakwire-check: no package.json, requirements*.txt or pyproject.toml found under ${root}`); setOutput('applicable-count', 0); setOutput('flagged-count', 0); return 0; }

  const results = [];
  for (const file of files) {
    let body, manifest;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const name = path.basename(file);
      if (name === 'package.json') {
        body = parsePackageJson(text, includeDev);
        if (!Object.keys(body.dependencies).length && !body.devDependencies && !body.engines) continue;
        const lockFile = path.join(path.dirname(file), 'package-lock.json');
        const locked = fs.existsSync(lockFile) ? lockVersions(fs.readFileSync(lockFile, 'utf8')) : {};
        const versions = {};
        for (const [n, spec] of Object.entries({ ...body.dependencies, ...(body.devDependencies || {}) })) versions[n] = locked[n] || exactVersion(spec);
        manifest = { eco: 'npm', versions };
      } else {
        const pkgs = name === 'pyproject.toml' ? parsePyproject(text, includeDev) : parseRequirements(text);
        if (!pkgs.length) continue;
        body = { packages: packagesForApi(pkgs) };
        manifest = { eco: 'pypi', versions: Object.fromEntries(pkgs.map((p) => [p.name, p.exact ? p.version : null])) };
      }
    } catch (e) { annotate('warning', `breakwire-check: could not parse ${file}: ${e.message}`, file); continue; }
    try {
      const r = await post(base, body, timeoutMs);
      results.push({ file, manifest, sent: body.packages || Object.keys({ ...body.dependencies, ...(body.devDependencies || {}) }), ...r });
    } catch (e) {
      const msg = `breakwire-check: Breakwire API unreachable for ${file} (${e.message}).`;
      if (failOnApiError) { annotate('error', msg, file); return 1; }
      annotate('warning', msg + ' Skipping; set fail-on-api-error: true to fail instead.', file);
    }
  }

  const seen = new Map();
  for (const r of results) for (const c of r.applicable || []) {
    const a = applies(c, r.manifest);
    const s = seen.get(c.cid) || { ...c, files: [], verdicts: [] };
    if (a !== 'no') s.files.push(r.file);
    s.verdicts.push(a); seen.set(c.cid, s);
  }
  const applicable = [...seen.values()].map((c) => ({ ...c, applies: c.verdicts.includes('yes') ? 'yes' : c.verdicts.every((v) => v === 'no') ? 'no' : 'unknown', files: c.files.length ? c.files : c.files })).filter((c) => c.applies !== 'no');
  const skipped = [...seen.values()].filter((c) => c.verdicts.every((v) => v === 'no')).map((c) => c.cid);
  const flagged = evaluate(applicable, { days, onDeadline, onAdvisory });
  for (const f of flagged) {
    const when = f.reason === 'deadline' ? `deadline ${f.deadline} (${f.days_left} days)` : f.applies === 'yes' ? 'advisory (your pinned version is in the affected range)' : 'advisory (version not pinned; check affected ranges)';
    annotate(f.level === 'fail' ? 'error' : 'warning', `${f.cid} ${when}: ${f.title}\nFix: ${f.fix || 'see claim'}\n${f.url}`, f.files[0]);
  }

  // We send both _ and - spellings of Python names; report a package as not covered only if no spelling was covered.
  const notCovered = [];
  for (const r of results) {
    const nc = new Set(((r.not_covered && r.not_covered.packages_without_mapping) || []).map((x) => String(x).toLowerCase()));
    const groups = new Map();
    for (const raw of r.sent.map((x) => x.replace(/(?<=.)@.*$/, '').toLowerCase())) groups.set(norm(raw), [...(groups.get(norm(raw)) || []), raw]);
    for (const [k, spellings] of groups) if (spellings.every((x) => nc.has(x)) && !notCovered.includes(k)) notCovered.push(k);
  }
  const lines = [`## Breakwire stack check`, '', `Scanned ${results.length} manifest(s): ${results.map((r) => '`' + r.file + '`').join(', ') || 'none'}. ${applicable.length} applicable claim(s), ${flagged.length} flagged (deadline window ${days} days).`, ''];
  if (flagged.length) {
    lines.push('| | Claim | Why | Fix |', '|---|---|---|---|');
    for (const f of flagged) lines.push(`| ${f.level === 'fail' ? '❌' : '⚠️'} | [${f.cid}](${f.url}) ${String(f.title).replace(/\|/g, '\\|')} | ${f.reason === 'deadline' ? `deadline ${f.deadline} (${f.days_left}d)` : 'advisory'} | ${String(f.fix || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)} |`);
    lines.push('');
  }
  const other = applicable.filter((c) => !flagged.some((f) => f.cid === c.cid));
  if (other.length) { lines.push('<details><summary>Other applicable claims</summary>', '', ...other.map((c) => `- [${c.cid}](${c.url}) ${c.title}${c.deadline ? ` (deadline ${c.deadline})` : ''}`), '', '</details>', ''); }
  if (skipped.length) lines.push(`Skipped as not applicable to your ecosystem or pinned versions: ${skipped.join(', ')}.`, '');
  lines.push(`Not covered by Breakwire (no claims, which does not mean nothing changed): ${notCovered.slice(0, 30).map((n) => '`' + n + '`').join(' ') || 'none'}.`, '', `Advisories fail only when a version pinned in the manifest or package-lock.json falls inside an affected range; unpinned dependencies get a warning. Deadlines apply per service, not per version. Claims are community data; each links its primary source.`);
  appendFile('GITHUB_STEP_SUMMARY', lines.join('\n') + '\n');
  if (!process.env.GITHUB_STEP_SUMMARY) console.log(lines.join('\n'));

  const reportPath = path.join(process.env.RUNNER_TEMP || require('os').tmpdir(), 'breakwire-check.json');
  fs.writeFileSync(reportPath, JSON.stringify({ applicable, flagged, results }, null, 2));
  setOutput('applicable-count', applicable.length);
  setOutput('flagged-count', flagged.length);
  setOutput('report-json', reportPath);
  const mode = input('comment', 'auto').toLowerCase();
  if (!['auto', 'true', 'false'].includes(mode)) throw new Error(`comment must be auto|true|false, got ${mode}`);
  const c = await upsertComment({ mode, token: input('github-token'), env: process.env, readFile: (f) => fs.readFileSync(f, 'utf8'), body: buildComment({ applicable, flagged, days, base }), hasClaims: applicable.length > 0 });
  if (c.url) { console.log(`breakwire-check: PR comment ${c.action}: ${c.url}`); setOutput('comment-url', c.url); }
  else if (c.action === 'skip' && mode === 'true') annotate('warning', `breakwire-check: PR comment not posted (${c.reason}). Add permissions: pull-requests: write.`);
  else if (c.action === 'skip') console.log(`breakwire-check: PR comment skipped (${c.reason}).`);
  const fails = flagged.filter((f) => f.level === 'fail').length;
  if (fails) { console.log(`breakwire-check: ${fails} claim(s) at level fail.`); return 1; }
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { annotate('error', `breakwire-check: ${e.message}`); process.exitCode = 1; });
