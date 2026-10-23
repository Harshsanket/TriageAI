# TriageAI

A **general-purpose, modular, self-hosted AI automation platform** — a small kernel; every capability (storage, queues, embedding, classification, retrieval, generation, validation, memory, delivery) is a replaceable adapter behind configuration; workflows are composable, inspectable, and auditable; all AI runs locally (no paid APIs, offline after models download).

Ship it as the **configuration you need**:

- `support` — customer-support automation: tickets, classification, routing, grounded RAG resolution, validation, human review, GitHub/Slack integrations.
- `assistant` — personal/KB assistant: chat, memory, knowledge base + RAG.
- `core` — just the kernel/hosts (rule-only or custom-built profiles).

**Status:** Phase 0 (contracts & docs reset) ✅ → **Phase 1 (kernel + hosts + Docker + module system) ✅** — `docker compose --profile core up` boots api + web + postgres; `modules/echo` demonstrates config-driven enable/disable, a pg-queue workflow with decision records, and manifest-gated UI; queue contract suite green on pg/inline adapters; ADRs 0009/0010 record the Phase-1 implementation decisions. Next: Phase 2 (inspector, observability, k6). See [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

## Documentation

| Document                                                             | Purpose                                                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)                         | Functional & non-functional requirements (platform + profiles)                                                   |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                         | System architecture, bridge to contracts, data model, deployment                                                 |
| [docs/DECISIONS.md](docs/DECISIONS.md)                               | **Start here** — decision index; links every ADR                                                                 |
| [docs/adr/](docs/adr/TEMPLATE.md)                                    | Architecture Decision Records (template + 0001…0008)                                                             |
| [docs/contracts/](docs/contracts/module-contract.md)                 | Module contract · capability interfaces · workflow contract · decision-record contract · contract testing policy |
| [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)                 | Phased plan with acceptance criteria                                                                             |
| [docs/RISKS_AND_OPEN_QUESTIONS.md](docs/RISKS_AND_OPEN_QUESTIONS.md) | Risk register + open questions                                                                                   |
| [docs/learnings/](docs/learnings/)                                   | Concept explanations preserved as we implement (Python/ML/RAG notes)                                             |

## Planned stack (see ARCHITECTURE.md / ADRs for rationale and context)

- **Frontend:** React + TypeScript (Vite SPA host), manifest-gated per-module UI
- **Backend/kernel:** Node.js + TypeScript (Fastify, Zod); kernel = registry/DI/events/workflow engine behind a thin SQL `Database` interface ([ADR-0009](docs/adr/0009-thin-sql-database-adapter.md))
- **AI service:** Python (FastAPI, sentence-transformers) — stateless local inference only, optional by profile
- **Data/stores:** PostgreSQL + Drizzle (app data), pgvector (initial vector store behind `VectorStore` capability); queue: Postgres-backed by default, Redis+BullMQ optional
- **Models (local, offline after install):** `all-MiniLM-L6-v2` embeddings/classification; SmolLM2-360M-Instruct first experimental generator via Ollama/LM Studio/MLX adapters — replaced via config, never hardcoded
- **Testing:** Vitest, pytest, RTL, Playwright, per-capability contract suites, k6, eval-driven CI gates
- **Target hardware:** MacBook Air M4 16GB (also runs CPU-only containers)
- **v1 scope:** single-tenant (day-one `org_id` readiness), text inputs (extensible input architecture), repo private until demo reviewed

## Repository layout

```
packages/
  kernel/        # core: registry, DI, config validation, events, workflow engine, contracts
  contracts/     # shared schemas (Zod → TS types + JSON Schema for Python sync)
apps/
  web/           # React host (manifest-gated module UI)
  api/           # Node host (Fastify): boots kernel, mounts enabled modules, /system/*
  ai-service/    # Python ML/AI inference (FastAPI) — optional per profile
modules/         # first-party modules: support · kb · ai-pipeline · chat · memory · doc-assistant · integrations-*
docs/            # requirements · architecture · contracts · ADRs · decisions · plan · learnings
```

First-party modules land phase by phase ([DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)); Phase 0 only wrote contracts + docs, so the tree above reflects targets.

## Prerequisites

- Docker with Compose v2 (pgvector + Redis images used when profiles need them)
- Node.js ≥ 20 and [pnpm](https://pnpm.io) — currently needed to develop on the host (Docker-only contributing is Phase 1's goal)
- Python 3.12+ and [uv](https://docs.astral.sh/uv/) — ai-service development only

## Quickstart (Phase 0 scaffold)

```bash
# 1. Install JS dependencies
pnpm install

# 2. Install Python deps (dev only)
uv --directory apps/ai-service sync --extra dev

# 3. Start Postgres + Redis (pre-kernel compose; Phase 1 replaces this with full profiles)
docker compose up -d

# 4. Environment config
cp apps/api/.env.example apps/api/.env
cp apps/ai-service/.env.example apps/ai-service/.env

# 5. Apply the first database migration
pnpm --filter @triageai/api db:migrate

# 6. Run the three hosts in parallel (api :3000, ai-service :8000, web :5173)
pnpm dev
```

Smoke checks:

- `curl http://localhost:3000/healthz` → `{"status":"ok","service":"api",...}`
- `curl http://localhost:8000/ai/v1/health` → `{"status":"ok","service":"ai-service",...}`
- Open `http://localhost:8000/docs` → FastAPI docs

`POST /ai/v1/classify` still returns the typed `501 NOT_IMPLEMENTED` stub — the classifier ships with the Phase 3 support vertical slice.

## Scripts

| Command            | What it does                                         |
| ------------------ | ---------------------------------------------------- |
| `pnpm dev`         | Run web + api + ai-service with reload               |
| `pnpm test`        | Vitest (TS) + pytest (Python)                        |
| `pnpm typecheck`   | `tsc --noEmit` across TS workspaces                  |
| `pnpm lint`        | ESLint (flat config)                                 |
| `pnpm format`      | Prettier                                             |
| `pnpm db:generate` | Generate a SQL migration from Drizzle schema changes |
| `pnpm db:migrate`  | Apply pending migrations (needs Compose running)     |

## Tech Stack

| Category | Technologies |
| --- | --- |
| Languages | TypeScript, JavaScript, Python |
| Frontend | React 19, Vite |
| Backend | Node.js, Fastify, FastAPI, Zod |
| Database | PostgreSQL, pgvector, Drizzle ORM |
| Queues | PostgreSQL, Redis, BullMQ |
| AI & ML | sentence-transformers, Ollama, LM Studio, MLX |
| AI Models | all-MiniLM-L6-v2, SmolLM2-360M-Instruct |
| AI Development Assistant | GLM 5.3 |
| Testing | Vitest, pytest, React Testing Library, Playwright, k6 |
| Infrastructure | Docker, Docker Compose, GitHub Actions |
| Development Tools | pnpm, uv, ESLint, Prettier |

## About

**TriageAI** is an open-source project focused on building modular, self-hosted AI automation systems. It prioritizes extensibility, local inference, and transparent decision-making.

Developed and maintained by **Harsh Sanket** in Mumbai, India, with development assistance from **GLM 5.3**.

## Sponsor

This project is proudly sponsored by **[kumarsidd](https://github.com/kumarsidd)**.

## License

Released under the GNU General Public License v3.0 — see [`LICENSE`](./LICENSE).

---

*Proudly made in Mumbai by Harsh Sanket.*

*A **Harsh Sanket** production.*