# TriageAI

A **modular, self-hosted AI automation platform** built around interchangeable components and configurable workflows.

TriageAI is designed to combine classification, retrieval, generation, validation, and human review into composable workflows. Capabilities can be replaced independently, with inspectable execution records and local AI inference.

## Configurations

- **`support`** — Customer-support automation with ticket classification, routing, RAG-based resolution, validation, human review, and integrations.
- **`assistant`** — Personal assistant with chat, memory, and knowledge-base retrieval.
- **`core`** — Minimal kernel and application hosts for custom workflows.

## Development Status

**Phase 0, 1, 2 and 3 complete:**

- **Kernel + module system** — config-driven enable/disable, capability seams, Docker profiles, and the `echo` reference module running queue-backed workflows on PostgreSQL.
- **Workflow engine (Phase 2)** — safe `when` guards, per-stage retries/backoff, per-attempt timeouts (`AbortSignal`), cancellation, and fallback policies (`retry_alternative_retrieval`, `halt_run`, `AWAITING` outcomes).
- **Inspector + feedback** — run list/detail at `/runs` with stage timelines, retries, and append-only decision records; corrections saved to `candidate_examples` with provenance.
- **Observability** — `/metrics` (runs, stages, queue, dead letters, decisions, process), hw-monitor at `/system`, and the optional `observ` profile (Prometheus + Grafana).
- **Performance** — k6 ingest/drain suite with a recorded baseline (0% errors, p95 ≈ 8 ms ingest, ~12.5 runs/s processing on the local Docker stack).
- **Support slice (Phase 3, no LLM)** — tickets → MiniLM embedding-similarity classification (τ/δ thresholds, per-category) → deterministic versioned routing → agent review queue with a typed ticket state machine. Safety-critical categories always escalate; an eval harness gates macro-F1, p95 latency, and **zero false auto-routing**.

**Next:** Phase 4 — knowledge base, retrieval, grounded generation, and the `assistant` profile.

Support automation, RAG, and assistant capabilities are planned for later phases and are not yet complete.

## Repository Layout

```text
packages/
  kernel/        # Registry, dependency injection, events, workflows, contracts
  contracts/     # Shared schemas and types
apps/
  web/           # React frontend host
  api/           # Node.js API host
  ai-service/    # Optional Python AI inference service
modules/         # Replaceable first-party modules
```

## Prerequisites

- Docker with Compose v2 — to run the application and its services.
- Node.js 20+ and [pnpm](https://pnpm.io) — for local frontend and backend development.
- Python 3.12+ and [uv](https://docs.astral.sh/uv/) — for local AI service development.
- [LM Studio](https://lmstudio.ai) — optional; required only for profiles configured to use its local model API.

## Quickstart

Start the currently implemented core services with Docker Compose:

```bash
docker compose --profile core up --build
```

For local development, install dependencies and configure the services:

```bash
pnpm install
uv --directory apps/ai-service sync --extra dev
cp apps/api/.env.example apps/api/.env
cp apps/ai-service/.env.example apps/ai-service/.env
```

Start the database, apply migrations, and run the development hosts:

```bash
docker compose up -d
pnpm --filter @triageai/api db:migrate
pnpm dev
```

The local development setup is intended to expose the API on port `3000`, the AI service on `8000`, and the web app on `5173`. Available services depend on the enabled configuration.

Phase-2 surfaces: workflow inspector at `/runs`, hardware monitor at `/system`, Prometheus metrics at `/metrics`, and the optional observability stack via `docker compose --profile observ up -d` (Prometheus `:9090`, Grafana `:3310`).

Support profile (classification + routing, **no LLM**): start the AI service and point the API at the support config:

```bash
docker compose --profile core --profile ai up --build
# or, with a host ai-service:
TRIAGEAI_CONFIG=/app/triage.config.support.json AI_SERVICE_URL=http://host.docker.internal:8000 \
  docker compose --profile core up --build
```

Then open `/support` in the web app and create a ticket — it is classified, routed, and (for security/unknown cases) escalated to human review.

## Scripts

| Command            | Purpose                           |
| ------------------ | --------------------------------- |
| `pnpm dev`         | Run development hosts with reload |
| `pnpm test`        | Run TypeScript and Python tests   |
| `pnpm typecheck`   | Check TypeScript types            |
| `pnpm lint`        | Run ESLint                        |
| `pnpm format`      | Run Prettier                      |
| `pnpm db:generate` | Generate Drizzle migrations       |
| `pnpm db:migrate`  | Apply database migrations         |

## About

**TriageAI** is an open-source project focused on building modular, self-hosted AI automation systems. It prioritizes extensibility, local inference, and transparent decision-making.

Developed and maintained by **Harsh Sanket**.  
**DeepSeek 4.1** was used during development.

## Tech Stack

| Category          | Technologies                                       |
| ----------------- | -------------------------------------------------- |
| Languages         | TypeScript, Python                                 |
| Frontend          | React 19, Vite                                     |
| Backend           | Node.js, Fastify, FastAPI, Zod                     |
| Database          | PostgreSQL, pgvector, Drizzle ORM                  |
| AI & ML           | all-MiniLM-L6-v2, SmolLM2-360M-Instruct, LM Studio |
| Testing           | Vitest, pytest, Playwright, k6                     |
| Infrastructure    | Docker, Docker Compose, Nginx, Prometheus, Grafana |
| Development Tools | pnpm, uv, ESLint, Prettier                         |

## Sponsor

The development of this project and my open-source work on GitHub are supported by **[kumarsidd](https://github.com/kumarsidd)**.

## License

Released under the GNU General Public License v3.0 — see [`LICENSE`](./LICENSE).

---

Proudly made in Mumbai by Harsh Sanket.

a **Harsh Sanket** production.
