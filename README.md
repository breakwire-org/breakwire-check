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
    deadline-policy: specific   # v1.2: only package/runtime/model matches block; service-only matches warn
    # models: claude-opus-4-7, text-embedding-004   # optional: lifecycle deadlines per model you call
    on-advisory: fail   # fail only when a pinned/locked version is in an affected range; unpinned => warning
```

Full workflows: [examples/breakwire.yml](examples/breakwire.yml) (fails), [examples/breakwire-warn-only.yml](examples/breakwire-warn-only.yml),
[examples/breakwire-weekly.yml](examples/breakwire-weekly.yml) (weekly cron, warn only).

**v1.2.0: fewer false blocks.** Deadlines matched only by service are warnings by default; per-model dates come from the claim's resources (Breakwire 0.9.0). Set `deadline-policy: any` for the old behaviour. Security: the stack request now follows only https redirects to the same origin or breakwire.org, at most 3 hops, and re-sends your dependency list only on 307/308 (earlier versions re-sent it to any `Location`).

**PR comment (v1.1).** On `pull_request` runs the action posts one short comment and updates it in place on later
runs: affected claims with links, a one-line outcome-report call, and a snippet to copy into `AGENTS.md`. It is on by
default (`comment: auto`) when the workflow grants `pull-requests: write`, and skips quietly when it doesn't. It
only creates a comment when at least one claim applies. `comment: false` turns it off; `comment: true` warns if it
cannot post.

| Input | Default | |
|---|---|---|
| `path` | `.` | Directory scanned recursively (skips node_modules, .git, venvs, dist, build) |
| `files` | | Explicit manifest list instead of scanning (newline or comma separated) |
| `days` | `30` | Deadline window |
| `on-deadline` | `fail` | `fail` / `warn` / `ignore` |
| `deadline-policy` | `specific` | v1.2.0. `specific`: a deadline fails the step only when it is tied to a package/version, runtime or model you use. A claim matched by service name alone (for example a model retirement found because you depend on that vendor's SDK) is reported as a warning. `any`: service-only deadlines also follow `on-deadline` (the v1.1 behaviour) |
| `models` | `''` | v1.2.0. Comma/newline list of model ids your code calls. Multi-model lifecycle claims then use that model's own date and state (an already-retired model is reported as overdue, a model whose shutdown is only an earliest-possible date shows that) |
| `on-advisory` | `fail` | Fails only for versions pinned in the manifest (`==1.2.3`, exact npm version) or `package-lock.json` that fall inside an affected range; otherwise warns |
| `include-dev` | `true` | devDependencies / dev groups |
| `base-url` | `https://breakwire.org` | |
| `fail-on-api-error` | `false` | An outage of Breakwire never breaks your build unless you set this |
| `timeout-seconds` | `20` | |
| `comment` | `auto` | `auto` / `true` / `false`: one updatable PR comment (needs `pull-requests: write`) |
| `github-token` | `${{ github.token }}` | Token for the PR comment |

Outputs: `applicable-count`, `flagged-count`, `report-json` (path to the full result), `comment-url`. Each flagged claim becomes an
annotation on the manifest, and the job summary lists everything that applies plus what Breakwire does not cover
("not covered" means no claims, not "nothing changed").

What it sends to Breakwire: package names and versions from your manifests (and `engines.node`). Nothing else from your repo. The PR comment goes only to GitHub, with your workflow token.

Limits, honestly: deadlines are matched per service (e.g. any Anthropic SDK version gets the model-retirement date);
advisory ranges are evaluated only when the version is pinned; Breakwire's community verification has just started.

MIT.
