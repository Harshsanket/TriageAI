# TriageAI

A **modular, self-hosted AI automation platform** built around interchangeable components and configurable workflows.

TriageAI is designed to combine classification, retrieval, generation, validation, and human review into composable workflows. Capabilities can be replaced independently, with inspectable execution records and local AI inference.

## Configurations

- **`support`** — Customer-support automation with ticket classification, routing, RAG-based resolution, validation, human review, and integrations.
- **`assistant`** — Personal assistant with chat, memory, and knowledge-base retrieval.
- **`core`** — Minimal kernel and application hosts for custom workflows.

## Development Status

**Phase 0 and Phase 1 complete:** Kernel, application hosts, Docker setup, and module system. The `core` Compose profile starts the API, web app, and PostgreSQL. The `echo` module demonstrates configurable modules and queue-backed workflows.

**Next:** Phase 2 — workflow inspection, observability, and performance testing.

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

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run development hosts with reload |
| `pnpm test` | Run TypeScript and Python tests |
| `pnpm typecheck` | Check TypeScript types |
| `pnpm lint` | Run ESLint |
| `pnpm format` | Run Prettier |
| `pnpm db:generate` | Generate Drizzle migrations |
| `pnpm db:migrate` | Apply database migrations |

## About

**TriageAI** is an open-source project focused on building modular, self-hosted AI automation systems. It prioritizes extensibility, local inference, and transparent decision-making.

Developed and maintained by **Harsh Sanket**.  
**GLM 5.3** by **Z.ai** was used during development.

## Tech Stack

| Category | Technologies |
| --- | --- |
| Languages | TypeScript, Python |
| Frontend | React 19, Vite |
| Backend | Node.js, Fastify, FastAPI, Zod |
| Database | PostgreSQL, pgvector, Drizzle ORM |
| AI & ML | all-MiniLM-L6-v2, SmolLM2-360M-Instruct, LM Studio |
| Testing | Vitest, pytest, Playwright |
| Infrastructure | Docker, Docker Compose |
| Development Tools | pnpm, uv, ESLint, Prettier |

## Sponsor

The development of this project and my open-source work on GitHub are supported by **[kumarsidd](https://github.com/kumarsidd)**.

## License

Released under the GNU General Public License v3.0 — see [`LICENSE`](./LICENSE).

---

Proudly made in Mumbai by Harsh Sanket.

a **Harsh Sanket** production.
