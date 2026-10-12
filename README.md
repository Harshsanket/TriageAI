# TriageAI

Full-stack, production-oriented, AI-powered customer support ticket management and automation platform.

TriageAI receives support tickets, classifies them with a lightweight local ML model (no paid LLM tokens for ordinary routing), routes them through a rules-based routing engine, resolves eligible tickets via a RAG (retrieval-augmented generation) pipeline grounded in a curated knowledge base, and escalates everything else to human support with full context preserved. A later phase adds advanced triage (priority, engineering team assignment) and Slack/GitHub integrations.

**Status:** Phase 0 complete — runnable monorepo scaffold; Phase 1 (vertical slice) next.

## Documentation

| Document                                                             | Purpose                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)                         | Functional & non-functional requirements, ticket state machine, out-of-scope items                                 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                         | System architecture, tech choices with rationale, module boundaries, data model, API contracts, AI pipeline design |
| [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)                 | Phased implementation plan with acceptance criteria and testing strategy                                           |
| [docs/RISKS_AND_OPEN_QUESTIONS.md](docs/RISKS_AND_OPEN_QUESTIONS.md) | Technical risks, mitigations, and decisions awaiting confirmation                                                  |

## Planned stack (locked — see ARCHITECTURE.md for rationale)

- **Frontend:** React + TypeScript (Vite), customer / support-agent / admin dashboards
- **Backend:** Node.js + TypeScript (Fastify, Zod, **Drizzle ORM**, PostgreSQL + pgvector, Redis + BullMQ)
- **AI service:** Python (FastAPI, SentenceTransformers) — stateless local inference only
- **AI models (all local, offline after install):** classification via `all-MiniLM-L6-v2` embeddings; RAG generation via small instruct models (SmolLM2-360M-Instruct and 1–2B candidates) through an MLX / LM Studio / Ollama adapter — **no hosted LLM APIs**
- **Testing:** Vitest, pytest, React Testing Library, Playwright; CI via GitHub Actions
- **Target hardware:** MacBook Air M4, 16GB — memory/speed efficiency are design constraints
- **v1 scope:** single-tenant, text-only tickets (no attachments), local-first (deployment deferred)

## Repository layout

```
apps/
  web/          # React frontend (Vite)
  api/          # Node.js backend (Fastify + Drizzle)
  ai-service/   # Python ML/AI service (FastAPI)
packages/
  shared/       # Shared TypeScript types & contracts (Zod)
docs/           # Project documentation
```

## Prerequisites

- Node.js ≥ 20 (tested on 24) and [pnpm](https://pnpm.io) 12+
- Python 3.12+ and [uv](https://docs.astral.sh/uv/)
- Docker with Compose (Postgres + pgvector, Redis)

## Quickstart (Phase 0)

```bash
# 1. Install JS dependencies
pnpm install

# 2. Install Python dependencies (creates .venv via uv)
uv --directory apps/ai-service sync --extra dev

# 3. Start Postgres + Redis
docker compose up -d

# 4. Environment config
cp apps/api/.env.example apps/api/.env
cp apps/ai-service/.env.example apps/ai-service/.env

# 5. Apply the first database migration
pnpm --filter @triageai/api db:migrate

# 6. Run all three apps in parallel (api :3000, ai-service :8000, web :5173)
pnpm dev
```

Smoke checks:

- `curl http://localhost:3000/healthz` → `{"status":"ok","service":"api",...}`
- `curl http://localhost:8000/ai/v1/health` → `{"status":"ok","service":"ai-service",...}`
- Open `http://localhost:8000/docs` → FastAPI interactive docs

`POST /ai/v1/classify` currently returns a typed `501 NOT_IMPLEMENTED` — the real local classifier lands in Phase 1.

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

## Status

Phase 0 complete: monorepo scaffold, tooling, CI, Docker Compose, baseline schema (`users`, `tickets`, `ticket_attachments` reserved for later), health checks, and the `/ai/v1` contract skeleton.

## License

TBD.
