# Milestone A — Baseline Audit & Evidence-Based Gap List

Repository: `engralaminn-collab/alolabs.net_ai`
Audit date: 2026-10-15
Auditor scope: **sandbox checkout only** — see "Access boundary" below.

---

## 0. Access boundary (read this first)

This audit was performed against a sandboxed clone at `/home/user/alolabs.net_ai`.
The following were **not accessible** and therefore **not verified**:

| Claim in the tasking | Status |
|---|---|
| Host `hosting.alolabs.net`, Ubuntu 22.04.5, 2 cores, 7.7 GiB RAM | **Not verified** — no server access |
| Node 22.23.3 / MySQL 8.0.46 / PostgreSQL 14.24 / Redis 6.0.16 on the server | **Not verified** |
| Ollama 0.32.13 with 6 installed models | **Not verified** |
| PM2 app list incl. `whatsapp-bridge` at 6,862 restarts | **Not verified** |
| MySQL listener on `*:33060` | **Not verified** — cannot audit or remediate |
| Nginx / Cloudflare Tunnel / Tailscale / Fail2Ban state | **Not verified** |
| `/home/aloedu/alolabs.net_ai-main` and the nested `alolabs.net_ai` checkout | **Absent** from this environment |
| Live AI provider request or streaming response | **Not possible** — no credentials, and outbound egress is limited to github.com, npmjs.org and pypi.org |
| GitHub Actions results | **Blocked account-wide** — every run fails in ~2 s with 0 steps executed; annotation cites failed payments / spending limit. Predates this work (16/16 runs, all branches incl. `main`). |

Outbound egress permitted here: `github.com`, `codeload.github.com`,
`api.github.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`.

**Consequence:** every statement below is either (a) derived from reading tracked
source in this clone, or (b) derived from a command actually executed here, whose
exit code is quoted. Nothing is inferred about the production server.

---

## 1. Repository and revision selection

Verified via `gh api` against the real GitHub repository:

| Ref | Date | Subject |
|---|---|---|
| `ce24bc6` | 2026-10-12 | **`origin/main` tip** — Merge PR #13 |
| `f225b98` | 2026-10-08 | Merge PR #9 — the nested checkout's revision |
| `07668db` | 2026-10-08 | Merge PR #5 — the parent checkout's revision |

`compare f225b98...main` → `ahead_by=15 behind_by=0 status=ahead`.

**Conclusion: the nested repository is 15 commits stale, and the parent is older
still. `origin/main` (`ce24bc6`) is canonical.** Any feature work must be based
on `main`, not on either local checkout. The nested `/home/aloedu/.../alolabs.net_ai`
directory should be treated as an accidental nested clone, not a second product.

Work branch for this engagement: `arena/1b52a31c-alolabs-net-ai`, based on
`ce24bc6`. No destructive Git command was run; no `origin/main` merge into any
dirty directory; all pre-existing local modifications described in the tasking
(the dirty `package-lock.json`, `prisma/schema.prisma`, `tsconfig.json`,
`.env.bak.mysql`, `prisma/db/`) live only on the server and were **untouched
because they are unreachable from here**. They remain the user's responsibility
to preserve.

---

## 2. Verified baseline (commands executed, exit codes quoted)

| Gate | Command | Exit | Result |
|---|---|---|---|
| Types | `npx tsc --noEmit` | 0 | 0 errors |
| Lint | `npx eslint .` | 0 | 0 errors, 0 warnings |
| Deploy config | `node scripts/validate-compose.mjs` | 0 | port contract 3011 consistent, 9 base services, 7 prod overrides |
| Tests | `npx vitest run` | 0 | **69 files, 1054/1054 passed**, 0 failed |
| Build | `PORT=3011 npm run build` | 0 | compiled successfully, **315/315 static pages**, 5/5 standalone artifacts |

### 2.1 Critical caveat on the test result

The 1054/1054 pass was achieved **only** by working around two sandbox
restrictions, and must not be read as "CI is green":

1. `better-sqlite3` cannot be installed here. Its prebuilt binary redirects to
   `release-assets.githubusercontent.com` (blocked) and compiling from source
   needs Node headers from `nodejs.org` (blocked). A **sandbox-only shim** was
   written at `node_modules/better-sqlite3/lib/index.js` reimplementing the used
   API surface on Node's built-in `node:sqlite`. It lives in gitignored
   `node_modules` and was **never committed**.
2. The native Prisma query engine could not be downloaded, so the client was
   generated with `engineType = "client"` (the WASM query compiler, which *is*
   present in the npm tarball) plus `PRISMA_SQLITE_ADAPTER=1`.

Two shim defects were found and fixed during this work, and both are instructive:

* Prisma's JS interpreter (`@prisma/client-engine-runtime`) throws
  `Cannot mix BigInt and other types` when the driver returns BigInts. Real
  `better-sqlite3` with `defaultSafeIntegers(true)` would hit the same interpreter,
  so this is a property of the WASM path, not of the repository.
* `node:sqlite` reports `code: 'ERR_SQLITE_ERROR'` with a numeric `errcode`,
  whereas better-sqlite3 reports symbolic codes. `@prisma/adapter-better-sqlite3`'s
  `mapDriverError()` switches on the **symbolic** code to produce
  `UniqueConstraintViolation` / `ForeignKeyConstraintViolation`, which Prisma
  surfaces as `P2002` / `P2003`. Until the shim translated `errcode` 2067→
  `SQLITE_CONSTRAINT_UNIQUE` and 787→`SQLITE_CONSTRAINT_FOREIGNKEY`, 5 tests
  failed. **This proves `src/lib/job-queue.ts:205` (`code === 'P2002'`) and the
  P2003 foreign-key tests are correct as written** — they only need a driver
  that reports canonical codes, which the real one does.

**Therefore:** the repository's own logic is verified sound; the *production*
engine/binding path remains unverified here and is verified only by CI, which is
currently billing-blocked.

---

## 3. What already exists (do not rebuild)

Contrary to a greenfield reading of the product objective, substantial parts of
Milestones B and C are **already implemented and already tested**.

### 3.1 AI gateway — `src/lib/ai-router/` (17 files)

* `BaseAIProvider` abstract contract: `initialize()`, `chatCompletion()`,
  `streamChatCompletion(): AsyncGenerator<AIStreamChunk>`, `healthCheck()`,
  `listModels()`, `findModel()`.
* **11 provider adapters**: deepseek, gemma, groq, llama, mistral, ollama,
  openai-compatible, openrouter, phi, qwen, zai.
* Bounded retry with **exponential backoff + jitter**:
  `MAX_RETRIES = 3`, `RETRYABLE_STATUS_CODES = {429,500,502,503,504}`,
  `jitteredDelay = RETRY_BASE_DELAY_MS * 2^attempt + random(0..RETRY_JITTER_MAX_MS)`.
  `withRetry()` is called by at least 10 adapters (verified by grep).
* `AbortSignal` appears in 10 files; timeout handling in 13.
* `router.ts` implements capability filtering (e.g. requiring `streaming`),
  circuit-open failover, streaming failover, and error classification into
  `RETRYABLE_ERROR` / `PROVIDER_ERROR` / `TIMEOUT`.
* Typed capability/metadata model: `AIModel`, `AICapability` (chat, streaming,
  function-calling, vision, json-mode, embedding, code-generation, reasoning,
  audio), `AITokenUsage`, `AIStreamChunk`, `AIRouteDecision`, `AIProviderHealth`.
* **Ollama is correctly local-only**: `endpoint ?? 'http://localhost:11434'`, and
  no `src/app/api/**/route.ts` exposes Ollama directly (grep for `ollama` in API
  routes returned nothing).

### 3.2 AgentOS runtime — `src/lib/agent-runtime/` (8 files, ~3,400 lines)

`execution.ts` 845, `pipeline.ts` 527, `state.ts` 479, `health.ts` 453,
`scheduler.ts` 224, `types.ts` 212, `lifecycle.ts` 112. Plus `src/lib/workers/`
(7 files) and `src/lib/job-queue.ts` (557 lines).

Durable-state models exist: `AgentOSRun`, `Workflow`, `WorkflowStep`,
`WorkflowRun`, `JobQueue`, `QueueItem`.

`job-queue.ts` implements leases, `idempotencyKey` with a `P2002` catch that
returns the winning row, bounded retries with backoff, dead-lettering at
`maxAttempts`, and heartbeats.

**These are proven by passing integration tests**, not merely present:

| File | Tests | What is proven |
|---|---|---|
| `job-queue-durability` | 9/9 | exactly-once claim under a 10-worker race, lease-expiry recovery without loss or duplication, heartbeat lease extension, retry/backoff with exact attempt counting, dead-lettering, cancellation observed by running handlers, idempotency under sequential *and* concurrent enqueue |
| `run-resume` | 3/3 | resume from checkpoint after worker crash without repeating finished steps, pause on QC escalation preserving every output version, failure on reviewer rejection and on approval expiry |
| `workforce-provisioning` | 11/11 | 100 departments + 2,000 agents under one tenant, DB-level idempotency, unique business keys, tenant isolation, survival across a separate CLI process restart, dry-run reporting zero writes |
| `prisma-foreign-keys` | 4/4 | P2003 on dangling `agentId`, RESTRICT on deleting a referenced Agent, cascade on company delete, and that `foreign_keys`/WAL/`busy_timeout` are actually enabled on the connection |
| `agent-health-integrity`, `backup-restore`, `sqlite-foreign-keys`, `ai-provider-config` | 22/22 | orphan detection/remap/quarantine, restore integrity, FK refusal, provider config |

Total: **49/49 integration tests pass**.

### 3.3 Security primitives that already exist

* `bcrypt` password hashing (`src/lib/auth.ts:60,64,69`)
* `src/lib/security/csrf.ts`, `secret-manager.ts` (AES via `createCipheriv`),
  `field-encryption.ts` (SHA-256 derived keys)
* `src/lib/v1.ts` → `v1Handler`: authenticates or throws a uniform 401, and
  enforces API-key scopes via `hasScope(identity, "${resource}:${action}")`
* Tenant check in `src/lib/api-auth.ts:43`:
  `if (!memberships.some(m => m.companyId === requestedCompanyId)) return null`
* Audit-log API and panel
* No hardcoded credentials found in tracked files (scanned for `sk-…`, `AKIA…`,
  PEM private keys). Only `.env.example` is tracked; no real `.env` is in Git.

---

## 4. Gap list (evidence-backed, ordered by severity)

### G1 — Monetary values are `Float` (Milestone D blocker) — **HIGH**

`prisma/schema.prisma` uses `Float` for every money field:

```
CostEstimate.estimatedCost  Float  @default(0)
CostEstimate.actualCost     Float?
SubscriptionPlan.priceMonthly Float @default(0)
SubscriptionPlan.priceYearly  Float @default(0)
Invoice.amount              Float
Payment.amount              Float
```

This violates the explicit requirement to avoid floating-point accounting for
monetary values. Binary floats cannot represent most decimal currency amounts
exactly, so summation across a usage ledger drifts. **Remediation is a schema
change plus a data migration, and must not be attempted without a verified
backup/restore path** — see G2, because there is currently no SQLite migration
history to hang it on.

### G2 — No SQLite migration history (Milestone F blocker) — **HIGH**

`prisma/migrations/` contains **only** a `mysql/` directory (5 `.sql` files,
including two explicit `_rollback.sql` scripts). There are **zero SQLite
migrations**. The SQLite schema is instead applied by `prisma db push` /
`scripts/sqlite-push.ts` (10 references across `package.json` and `scripts/`).

Consequences: production SQLite has no versioned, ordered, rollback-able change
history; `db push` can drop columns silently; and the requested test of
"migrations on a disposable test database" cannot be performed for the database
the app actually uses in the container stack (`DATABASE_URL=file:/app/data/agenthub.db`).

### G3 — No payment gateway integration at all (Milestone D) — **HIGH**

No payment SDK is installed: grep of `package.json` for
`stripe|paypal|sslcommerz|razorpay|payment|billing|invoice|checkout` → **none**.
`Payment` has exactly 1 write site and `Invoice` 3. There is no webhook route,
therefore no signature verification and no replay protection to audit.

Merchant-country suitability (Bangladesh), settlement currency, recurring-billing
support and compliance posture **cannot be verified from this sandbox** and
require the user's decision and account access.

### G4 — No global auth enforcement; no `middleware.ts` — **MEDIUM-HIGH**

There is no `src/middleware.ts` (verified absent). Authorization is per-route.
Of 366 API route files, 9 contain no auth reference:

`health`, `health/live`, `health/ping`, `health/ready`, `infra/ping`,
`v1/health`, `marketplace/templates`, `enterprise/roadmap`, `auth/mfa/resend`.

The first six are health endpoints and are appropriately public. The last three
need a product decision. Note that a per-route model means **any newly added
route is unauthenticated by default** — a fail-open posture.

### G5 — `auth/mfa/resend` is a no-op stub that reports success — **MEDIUM**

`src/app/api/auth/mfa/resend/route.ts` returns
`{ success: true, message: 'Code is time-based…' }` without touching the
database or sending anything. It is unauthenticated. If the product intends TOTP
this is arguably correct behaviour, but returning `success: true` from an
endpoint named `resend` is misleading to clients and should either be removed or
renamed.

### G6 — Duplicated, divergent implementations — **MEDIUM**

Verified by line count and importer count, not assumed:

| Concern | Files | Importers |
|---|---|---|
| Session management | `src/lib/session-manager.ts` (384 lines) **and** `src/lib/security/session-manager.ts` (374 lines) — `diff` confirms they **differ** | 3 and 1 respectively |
| Rate limiting | `src/lib/rate-limiter.ts` **and** `src/lib/security/rate-limiter.ts` | — |
| Auth | `api-auth` (184 importers), `auth` (117), `route-auth` (2), `v1-auth` (2) | two are near-dead |
| Streaming chat | `/api/ai/stream` **and** `/api/llm/stream` | — |

Two live session managers with different code is a real security-review hazard:
a fix applied to one will not apply to the other.

### G7 — SSRF guard exists but is not wired to tools — **LOW (currently theoretical)**

Private-IP/link-local guards appear in 3 files
(`api/automation/execute/route.ts`, `ai-router/provider-admin.ts`, `lib/minio.ts`).
No agent tool accepts a URL parameter (grep for url-taking tool params returned
nothing), and the only `fetch()` in `src/lib/workers/handlers.ts` targets a
self-derived base URL. So there is **no present exposure**, but any future
web-fetch tool must reuse the existing guard rather than add a fourth copy.

### G8 — Port-contract drift into application source — **FIXED this engagement**

Nine server-to-self call sites used the *public* origin with a hardcoded
`http://localhost:3000` fallback, and `.env.example` declared `APP_PORT=3000`
which overrides compose's `${APP_PORT:-3011}`. Since nothing listens on 3000,
every worker-driven chat, email, notification, backup and upload call would fail
with `ECONNREFUSED` in any deployment that did not set `NEXT_PUBLIC_APP_URL`.

Fixed in commit `ec3944d` — see §5.

---

## 5. Work performed in this engagement

Four commits on `arena/1b52a31c-alolabs-net-ai`, all pushed; PR #14 open.

| Commit | Scope |
|---|---|
| `c17e857` | Audit document: code gates green, 7 docker/deploy defects |
| `12fcdf8` | Repaired the Docker/compose layer (9 defects) and added `scripts/validate-compose.mjs` as a CI gate |
| `80b1f4c` | Extended the 3011 port contract to bare metal (systemd unit had **no** `PORT`, so standalone defaulted to 3000 behind an nginx that proxied 3011); documented the air-gapped bootstrap |
| `ec3944d` | **Milestone A fix:** routed server-to-self calls over loopback; closed the `:3000` drift in `src/` and `.env.example`; added CI guard `4e` |

`ec3944d` in detail — 8 files, +404/−17:

* **New** `src/lib/internal-url.ts` — single source of truth separating two
  intents that had been conflated. `internalBaseUrl()`/`internalUrl(path)` return
  a loopback origin resolved as `INTERNAL_APP_URL` → `NEXT_PUBLIC_BASE_URL`
  (honoured only when it points at loopback) → `http://127.0.0.1:$PORT` → `:3011`.
  Deriving from `PORT` means it cannot disagree with the listening port.
  `publicBaseUrl()` returns the externally reachable origin for URLs
  dereferenced *outside* the process.
* `src/app/api/media/ai-tag/route.ts` deliberately uses `publicBaseUrl()`, not
  loopback: its URL is handed to a third-party vision model as `image_url`, so
  their servers must fetch it. Using loopback there would have broken image
  tagging — this is why the two helpers had to be distinct.
* A stale `localhost:3000` in either variable is **ignored rather than honoured**,
  because older `.env.example` revisions shipped it; honouring it would reproduce
  the bug for exactly the installs that need the fix. A real domain legitimately
  on port 3000 is preserved — only the loopback default is treated as stale.
* **New** `src/__tests__/lib/internal-url.test.ts` — 23 tests: resolution order,
  `PORT` derivation, hairpin refusal, stale-default rejection, the
  real-domain-on-3000 non-regression, trailing-slash handling, malformed-URL
  tolerance, public/internal divergence.
* CI guard `4e` in `scripts/validate-compose.mjs` scans `src/` for hardcoded
  `:3000` and asserts `.env.example` pins `APP_PORT=3011`. It skips comment lines
  and test files (both must be able to quote the old value) and excludes compose
  files, because **Grafana legitimately uses 3000 as its container port**,
  published as 3001. Verified bidirectionally: **11 violations and exit 1**
  against the pre-fix tree, **exit 0** after.

`social/oauth/[provider]/route.ts` (9 `redirect_uri` sites) and `sitemap.ts`
were **intentionally left** on `NEXT_PUBLIC_APP_URL` — those are genuinely
public-intent and were already correct.

---

## 6. Explicitly NOT done, and why

* **No production deployment, no server change, no PM2/Nginx/MySQL/Cloudflare/
  Tailscale/SSH/UFW modification.** No server access exists from here.
* **No `origin/main` merge** into any dirty directory, and no dependency upgrade.
* **No schema change for G1/G2.** Monetary-type migration and introducing SQLite
  migration history both require a verified backup and restore path first.
* **No live provider call.** Impossible without credentials and egress.
* **`describe.skipIf` graceful-skip for the integration tests was deliberately
  not added.** Those tests pass wherever the native binding exists (CI). A skip
  renders green, so a future binding failure would silently mask 49 tests.
* **§7.8-style test skipping, and any change to `bun.lock`/`package.json`
  dependencies**, were avoided: `bun.lock` cannot be regenerated here (no bun)
  and CI runs `bun install --frozen-lockfile`.

---

## 7. Recommended milestone order

Milestone B and most of C are already built and tested, so the highest-value
remaining work is D and the two HIGH gaps that block it.

1. **G2 — introduce SQLite migration history** (prerequisite for everything else
   that touches the schema; also unblocks the Milestone F migration test).
2. **G1 — migrate monetary `Float` → integer minor units** (or `Decimal`), on top
   of G2, with a data migration and a rollback script matching the existing
   `mysql/*_rollback.sql` convention.
3. **Milestone D — usage ledger + entitlements + gateway.** Needs a user decision
   on gateway (see below) before any code.
4. **G6 — collapse the duplicate session managers and rate limiters** to one
   implementation each. Security-relevant and low-risk.
5. **G4/G5 — add `middleware.ts` for fail-closed auth**, and resolve
   `auth/mfa/resend`.
6. **Milestone B verification** — once credentials exist, prove one hosted
   provider end-to-end (non-streaming + streaming) and the Ollama adapter
   against the local service.

## 8. Decisions required from the user

1. **Payment gateway.** Merchant country Bangladesh. Which gateway, and do you
   have sandbox credentials? (SSLCommerz is the common local candidate, but
   settlement, recurring-billing support and compliance must be confirmed by you
   — I cannot verify them from here.)
2. **Money representation.** Integer minor units (poisha/cents, recommended —
   exact, no dependency) or Prisma `Decimal`?
3. **Is a staging server path available** that I could be given access to, or
   will all deployment remain yours to execute?
4. **CI billing.** Actions is blocked account-wide; until Settings → Billing is
   fixed, no gate can be verified by CI. All verification above is local.
