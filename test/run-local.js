'use strict';
// Run the action locally the way the runner does (INPUT_<NAME> env vars, hyphens kept).
// node test/run-local.js path=test/fixtures days=60 base-url=https://breakwire.org
const { spawnSync } = require('child_process');
const env = { ...process.env };
for (const a of process.argv.slice(2)) { const i = a.indexOf('='); env[`INPUT_${a.slice(0, i).toUpperCase()}`] = a.slice(i + 1); }
const r = spawnSync(process.execPath, [require('path').join(__dirname, '..', 'index.js')], { env, stdio: 'inherit' });
process.exit(r.status);
