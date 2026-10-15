# Paid / external-service gating in CI (`SKIP_PAID_SERVICES`)

This repository is **private**, so every GitHub-hosted runner minute is billed
out of the account allowance. `SKIP_PAID_SERVICES` is the single switch that
decides whether a workflow is allowed to spend money or touch production.

## Default deny

Paid steps run **only on an explicit opt-in**. Everything else skips:

| Value of `SKIP_PAID_SERVICES` | Result |
| --- | --- |
| unset or empty | **skip** — this is the fork-PR case, where secrets are not delivered |
| `true` | **skip** |
| typo / anything unrecognised (`flase`, `maybe`) | **skip** |
| `false`, `0`, `no`, `off` (any case, whitespace and quotes tolerated) | run |

Default deny matters because repository secrets are **not** passed to a runner
for a `pull_request` from a fork. If the flag defaulted the other way, a
missing secret would mean "run the paid step".

## Precedence

1. `run_paid_services` — the `workflow_dispatch` boolean input (per-run opt-in)
2. `vars.SKIP_PAID_SERVICES` — repository **Variable**
3. `secrets.SKIP_PAID_SERVICES` — repository **Secret**
4. `env.SKIP_PAID_SERVICES: 'true'` — the workflow default

A **Variable is preferred over a Secret** here: the value is not sensitive, and
unlike secrets it is readable in contexts such as `jobs.<job_id>.if`.

## What is actually gated

| Workflow | Gated thing | Default | Why |
| --- | --- | --- | --- |
| `deploy.yml` | `deploy` job — SSH into the production host | skipped | touches production |
| `backup.yml` | `backup` job — SSH into the production host | skipped | touches production; the `0 2 * * *` cron cannot start on its own |
| `docker.yml` | the `linux/arm64` build leg | amd64 only | arm64 runs under QEMU emulation and is the largest minutes consumer |
| `backup-portability.yml` | the `macos-latest` matrix leg | Linux only | a macOS minute bills at roughly 10x a Linux minute ($0.062 vs $0.006). Always runs on the weekly `30 6 * * 1` schedule |
| `ci.yml`, `security*.yml` | nothing today | — | the advisory database and gitleaks are free, so the security gates stay on |

The test suite has **no** tests that call a billed third-party API — the
provider and webhook specs stand up a local `http.createServer` on
`127.0.0.1`. The guard below exists so that stays true.

## Enabling paid steps

### One-off run (no config change)

GitHub UI: **Actions → the workflow → Run workflow → tick
`run_paid_services`**.

CLI:

```bash
gh workflow run deploy.yml --ref main -f migrations_approved=true -f run_paid_services=true
gh workflow run docker.yml -f run_paid_services=true
gh workflow run backup.yml -f run_paid_services=true
```

### Persistent (recommended: repository Variable)

UI: **Settings → Secrets and variables → Actions → Variables → New repository
variable** → name `SKIP_PAID_SERVICES`, value `false`.

CLI (needs a token with the `administration` scope — see `CI_PAID_SERVICES`
setup notes):

```bash
gh variable set SKIP_PAID_SERVICES --body false
```

Set it back to `true`, or delete the variable, to restore default-deny.

## Implementation

- `scripts/ci-paid-services.sh` — the resolver, and the single source of truth.
  Prints `true` (skip) or `false` (run).
- `__tests__/helpers/paid-services.ts` — the same rules for the test suite,
  plus `itPaid` / `describePaid` and the outbound-fetch guard.
- `__tests__/unit/ci-paid-services.test.ts` — pins the default-deny contract
  and asserts the shell and TypeScript resolvers agree on every input.
- `scripts/validate-workflows.mjs` (`bun run lint:workflows`) — workflow linter.

### Why some gates live in a separate `resolve` job

The official context-availability table allows only `github, needs, vars,
inputs` in `jobs.<job_id>.if` — **`secrets` is not available there**. To honour
a Secret while still gating a whole job, a small `resolve` job reads it in
`steps.env` (where secrets are allowed), runs the resolver, and publishes the
verdict as a job output. The gated job then uses `needs.<job>.outputs.*`.

<https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability>

### Writing a test that needs a paid API

```ts
import { describePaid, itPaid } from '../helpers/paid-services';

describePaid('live DeepSeek completion', () => {
  itPaid('returns a completion', async () => { /* ... */ });
});
```

It is reported as **skipped**, never passed, so a green run cannot hide an
untested path. Prefer a local stub server instead — see
`__tests__/integration/ai-provider-config.test.ts`.

While `SKIP_PAID_SERVICES` is active, `__tests__/setup.ts` wraps the real
`fetch` so any non-loopback request rejects. Loopback stays reachable, so the
existing local-server tests are unaffected.

## Other hardening applied to these workflows

- **All actions pinned to full commit SHAs** with a `# vN` comment naming the
  tag, instead of moving tags such as `@v1`. A compromised upstream tag cannot
  silently change what this repository executes.
  <https://docs.github.com/en/actions/reference/security/secure-use>
- **`permissions: contents: read`** at the top level of every workflow, with
  `packages: write` scoped to the single job that pushes to GHCR.
- **`timeout-minutes` on every job.** Without it a hung job burns the 6-hour
  default at full price — 10x on a macOS runner.
- `security-scan.yml` now publishes its audit output as an artifact instead of
  writing `audit-results.txt` that nothing collected.

## References

- Using secrets — <https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets>
- Contexts reference — <https://docs.github.com/en/actions/reference/workflows-and-actions/contexts>
- Secure use of GitHub Actions — <https://docs.github.com/en/actions/reference/security/secure-use>
- Deployment environments — <https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments>
- Controlling deployments — <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments>
- Managing deploy keys — <https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys>
- Actions billing — <https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions>
