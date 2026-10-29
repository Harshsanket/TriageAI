# AGENTS.md — Operating guide for AI agents working on TriageAI

You are working on **TriageAI**: a modular, self-hosted AI automation platform (small kernel + swappable modules/adapters) built from a **monorepo** with **pnpm workspaces**. This file tells you how to move through the repo without breaking its contracts.

## Read first (in this order)

1. `docs/DECISIONS.md` — decision index; the governing ADRs (0001–0010).
2. `docs/DEVELOPMENT_PLAN.md` — phases, acceptance criteria, what is done; phase docs are updated **in the same change** as the code.
3. `docs/contracts/` — module contract, capability seams, workflow contract, decision-record contract, contract-testing policy.
4. `AGENTS.md` (this file) is operational; `docs/` is the source of truth. When code and docs disagree, one of them is stale — fix it, don't ignore it.

## Layout

```
packages/kernel/     # the only framework-level code: boot, config, module graph,
                     # migrations, workflow engine, decision records, queue/db/eventbus
packages/contracts/  # Zod DTO schemas shared by TS/Python (source of truth for shapes)
packages/rag/        # prompt boundaries, chunking, grounding, deterministic validation
packages/integrations-core/  # audited action rows + approve/reject/retry routes for integrations
apps/api/            # Fastify host: boots the kernel, mounts module routes, /api/v1/system/*
                     #   src/platform (config, logger, errors, auth) · src/services · src/routes
config/presets/      # shipped starting configs (support, assistant, full, …); root triage.config.json is yours
apps/web/            # React host: fetches system manifest, renders ONLY enabled modules
apps/ai-service/     # Python FastAPI inference service (optional, profile [ai])
modules/             # first-party feature modules (echo = reference implementation)
docs/                # requirements, architecture, contracts, ADRs, learnings
```

## Hard rules (violations = reject the change)

- **Kernel has no use-case vocabulary.** No words like "ticket", "support", "chat", "classifier" in `packages/kernel` (ADR-0001). Feature concepts live in `modules/*` only.
- **Modules touch nothing outside `KernelContext`.** No direct imports of other modules, no singleton grabs, no cross-module DB requests. They get `ctx.database | ctx.queue | ctx.events | ctx.logger | ctx.registerRoute | ctx.registerStageHandler`.
- **Docs are artifacts, not garnish.** Any behavior/contract change updates: the ADR (if a decision), the affected `docs/contracts/*` file, and `docs/DEVELOPMENT_PLAN.md` phase status — in the same change, never reconstructed later.
- **Two-consumer rule (ADR-0002):** don't finalize an abstraction until two real implementations/consumers exist. Keep seams thin.
- **Migrations are immutable.** Same `id` + different SQL checksum = boot failure by design. Never edit an applied migration; add a new one. `dropSql` only runs on explicit uninstall.
- **Never `JSON.stringify` a param targeting a JSONB column.** postgres-js serializes JS objects; stringify stores a string scalar and DTO parsing will catch it and your test will fail.
- **Model names are config-bound.** No hardcoded MiniLM/SmolLM2/etc. assumptions (ADR-0008).
- **Never push to git.** Commits only when the user asks. Never commit secrets/worktrees in `apps/api/.env*`.

## Commands

```bash
pnpm install                          # first time
pnpm dev                              # api + web hot-reload (needs postgres/redis up)
pnpm lint                             # eslint
pnpm typecheck                        # all apps/packages/modules
pnpm test:ts                          # vitest across apps/packages/modules
pnpm test:python                      # pytest (apps/ai-service, via uv)
pnpm format                           # prettier write; CI enforces format:check
docker compose --profile core up -d   # postgres + api + web (default profile: core)
docker compose --profile queue up -d redis   # optional queue profile (bullmq, Phase 2+)
docker compose --profile ai up -d     # ai-service + HF cache volume
docker compose --profile llm up -d    # + ollama
docker compose --profile observ up -d # prometheus + grafana
docker compose --profile core build   # api/web images
```

DB-backed suites (pg-queue contract tests, kernel boot integration, api tests) need `DATABASE_URL` — local default `postgres://triageai:triageai@localhost:5432/triageai` (dev: `docker compose up -d` postgres first; CI: service container). Set `SKIP_DB_TESTS=1` to skip DB suites. **Stop `pnpm dev` first** (or point `DATABASE_URL` at a dedicated test database): the running API shares Postgres and the pg-queue worker, so it consumes workflow jobs created by the tests and they fail intermittently; the Phase-5 suite also clears `kb_docs`.

## Testing expectations (before you say "done")

Run, in this order, and make them green: `pnpm lint` → `pnpm typecheck` → `pnpm test:ts` (+ `pnpm test:python` if Python touched) → `pnpm format:check`. A new queue/DB/eventbus adapter or capability implementation **must pass its contract suite** (`packages/kernel/src/queue/contract.ts` is the pattern); a new public DTO gets a Zod schema in `packages/contracts` and JSON Schema export stays trivially available.

Tests are colocated (`test/` dirs), use vitest for TS, pytest for Python, RTL + jsdom for web. Prefer contract-style tests (behaviors, not implementation details). The web app tests mock `fetch` at the boundary. Follow existing patterns in `packages/kernel/test/*` and `apps/api/test/gating.test.ts`.

## Phase-1 semantics you must preserve

- **Manifest gating:** `apps/web` renders nav/routes/pollers strictly from `GET /api/v1/system/manifest`; a module disabled in config produces **zero orphans** (no nav item, no route, no poller). Enabling/disabling is config-only (restart-time), enforced by `kernel` boot (ADR-0007, gate tests in `apps/api/test/gating.test.ts`).
- **Queues are at-least-once; effects are exactly-once downstream.** Workflows guard re-delivery via run-status; `start()` dedupes by idempotency key. New workers must be idempotent.
- **Decision records are append-only** and every engine stage writes one (evidence / deterministic / timings / error) — see `docs/contracts/decision-record-contract.md`.
- **Enable/disable is config-only; uninstall is an explicit admin command** that drops module tables. Enabled modules refuse uninstall with `kernel.CONFLICT`.

## Working agreement

- Small, horizontal-capable changes; keep module surface uniform: scaffold with `scripts/new-module.sh <name>` and follow the layout in `docs/contracts/module-contract.md` §6 (`modules/support` is the split-file reference, `modules/echo` the minimal one). Every new route needs an RBAC rule (`apps/api/test/rbac-coverage.test.ts` enforces it).
- TypeScript: strict, NodeNext `.js` import suffixes, zod at boundaries, no default exports in libraries (React components exempt).
- Commit messages: imperative, concise, matching repo style. Stage files deliberately — this repo often has deliberately uncommitted docs while a phase is in review; **do not stage or commit files you were not asked to commit**.
- When blocked by environment (Docker not up, DB missing), say so — don't silently skip DB tests and call it green.
- Wrong-looking docs? Raise/fix in the same change rather than coding around them.
