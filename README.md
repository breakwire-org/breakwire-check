# breakwire-check (GitHub Action)

Fails or warns when a dependency in `package.json`, `requirements*.txt` or `pyproject.toml` has a
[Breakwire](https://breakwire.org) deadline (model retirement, API shutdown, required migration) within N days, or a
security advisory that covers the version you pinned. Uses `POST https://breakwire.org/api/stack`. Zero dependencies,
`node24`.

```yaml
- uses: actions/checkout@v7
- uses: breakwire-org/breakwire-check@v1
  with:
    days: 30            # deadline window
    on-deadline: fail   # fail | warn | ignore
    on-advisory: fail   # fail only when a pinned/locked version is in an affected range; unpinned => warning
```

Full workflows: [examples/breakwire.yml](examples/breakwire.yml) (fails), [examples/breakwire-warn-only.yml](examples/breakwire-warn-only.yml).

| Input | Default | |
|---|---|---|
| `path` | `.` | Directory scanned recursively (skips node_modules, .git, venvs, dist, build) |
| `files` | | Explicit manifest list instead of scanning (newline or comma separated) |
| `days` | `30` | Deadline window |
| `on-deadline` | `fail` | `fail` / `warn` / `ignore` |
| `on-advisory` | `fail` | Fails only for versions pinned in the manifest (`==1.2.3`, exact npm version) or `package-lock.json` that fall inside an affected range; otherwise warns |
| `include-dev` | `true` | devDependencies / dev groups |
| `base-url` | `https://breakwire.org` | |
| `fail-on-api-error` | `false` | An outage of Breakwire never breaks your build unless you set this |
| `timeout-seconds` | `20` | |

Outputs: `applicable-count`, `flagged-count`, `report-json` (path to the full result). Each flagged claim becomes an
annotation on the manifest, and the job summary lists everything that applies plus what Breakwire does not cover
("not covered" means no claims, not "nothing changed").

What it sends: package names and versions from your manifests (and `engines.node`). Nothing else from your repo.

Limits, honestly: deadlines are matched per service (e.g. any Anthropic SDK version gets the model-retirement date);
advisory ranges are evaluated only when the version is pinned; Breakwire's community verification has just started.

MIT.
