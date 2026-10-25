# TriageAI
A **modular, self-hosted AI automation platform** built around interchangeable components and configurable workflows.

TriageAI combines classification, retrieval, generation, validation, and human review into composable workflows. Capabilities are replaceable independently, every decision is inspectable, and inference stays local.

## Configurations

- **`support`** — Ticket classification, routing, KB-grounded auto-reply with validation/fallbacks, human review, and customer confirmation.
- **`assistant`** — KB-grounded chat and a doc-assistant that answers from this repository's `docs/**` with file-path citations.
- **`full`** — Support + chat + KB + doc-assistant in one process (the easiest way to see everything).
- **`core`** — Minimal kernel and application hosts for custom workflows.
- **`integrations`** — Support plus optional GitHub/Slack outward actions (`triage.config.integrations.json`); enable/disable and credentials stay config/env-only.

## Repository Layout

```text
packages/
  kernel/        # Boot, config, module graph, events, workflows, queues, decision records
  contracts/     # Shared Zod DTOs (feedback/datasets/models included) → JSON Schema
  rag/           # Prompt boundaries, chunking, grounding, deterministic validation
apps/
  web/           # React host (module pages, inspector, /feedback review queue)
  api/           # Fastify host (system, inspector, datasets, model registry API)
  ai-service/    # Optional Python inference service + eval/ + train/ (CPU seed)
modules/         # Replaceable first-party modules
  integrations-github/  # github-issue OutputChannel, approval gates, webhook sync
  integrations-slack/   # slack-message OutputChannel, routing/batching/dedupe
  support/ · kb/ · chat/ · ai-pipeline/ · doc-assistant/ · echo/
perf/k6/          # ingest/drain + Phase-8 burst, fairness, hot-swap suites
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

Start Postgres (the kernel applies migrations on boot) and run the development hosts:

```bash
docker compose up -d postgres
pnpm dev
```

Local dev exposes the API on `:3000`, the web app on `:5173`, and (when running) the AI service on `:8000`. Available UI modules depend on the config file; see below.

**Auth:** development/test defaults to `AUTH_MODE=disabled` (single-operator convenience). To exercise identity, set `AUTH_MODE=required` and `AUTH_JWT_SECRET` (32+ chars) for the API; the web host then shows a login screen and `POST /api/v1/auth/register` creates the first admin (registration closes afterwards; admins add users via `POST /api/v1/auth/users`). Never run `AUTH_MODE=disabled` on a reachable host.

### Run everything locally (full profile)

```bash
# 1. Postgres + Ollama
docker compose up -d postgres
docker compose --profile llm up -d ollama
docker exec triageai-ollama ollama pull qwen2.5:1.5b

# 2. AI service (embeddings + classification) on the host
uv --directory apps/ai-service run uvicorn app.main:app --host 127.0.0.1 --port 8000

# 3. API + web with every module enabled
TRIAGEAI_CONFIG=triage.config.full.json pnpm dev
```

Open:

- `http://localhost:5173/chat` — grounded chat over the KB
- `http://localhost:5173/support` — tickets + auto-reply + confirmation
- `http://localhost:5173/kb` — add/approve knowledge-base documents
- `http://localhost:5173/doc-assistant` — ask about this repo's docs
- `http://localhost:5173/runs` — inspector with stage timelines and decision records
- `http://localhost:5173/feedback` — review queue, datasets, model registry, audit trail

The chat is **grounded**: it answers from approved KB documents and refuses when retrieval is insufficient ("I could not verify this from the knowledge base."). Add docs in `/kb` for new topics. If a question refuses, check `/runs` for the retrieval gate and validation checks.

Phase-2 surfaces: workflow inspector at `/runs`, hardware monitor at `/system`, Prometheus metrics at `/metrics`, and the optional observability stack via `docker compose --profile observ up -d` (Prometheus `:9090`, Grafana `:3310`).

Assistant profile (KB + retrieval + local generation): first download a model into the local runtime, then start the assistant stack:

```bash
docker compose --profile llm up -d
docker exec triageai-ollama ollama pull qwen2.5:1.5b
TRIAGEAI_CONFIG=/app/triage.config.assistant.json docker compose --profile core up --build
```

Open `/kb` to add and approve documents, then `/chat` to ask grounded questions (answers cite their sources). `TRIAGEAI_CONFIG=/app/triage.config.assistant.json` points the API at the assistant module set; without it the default core profile runs.

Run everything together (support + chat + KB + doc-assistant) with `TRIAGEAI_CONFIG=/app/triage.config.full.json`; the chat is grounded, so questions without an approved KB source are refused by design.

Generator address: configs point at `http://localhost:11434` for host-run dev. The API container defaults to `http://ollama:11434`; set `TRIAGEAI_GENERATOR_BASE_URL` to override (e.g. `http://host.docker.internal:11434` for an Ollama on the host, or any remote runtime).

Support profile (classification + routing, **no LLM**): start the AI service and point the API at the support config:

```bash
docker compose --profile core --profile ai up --build
# or, with a host ai-service:
TRIAGEAI_CONFIG=/app/triage.config.support.json AI_SERVICE_URL=http://host.docker.internal:8000 \
  docker compose --profile core up --build
```

Then open `/support` in the web app and create a ticket — it is classified, routed, and (for security/unknown cases) escalated to human review.

Support auto-reply profile (classification + routing + KB + local generation): same AI service and model, but retrieval and a local generator are enabled so routed tickets can receive a grounded answer:

```bash
docker compose --profile llm up -d
docker exec triageai-ollama ollama pull qwen2.5:1.5b
TRIAGEAI_CONFIG=/app/triage.config.support-autoreply.json docker compose --profile core up --build
```

Auto-reply is per-category and versioned (`GET/PUT /api/v1/support/auto-reply-policies`): disable it for a category and the **next** ticket escalates without a deploy. Replies move the ticket to `AWAITING_CUSTOMER`; `POST /api/v1/support/tickets/:id/confirmation` with `{ "solved": true | false }` resolves or escalates, and identical failed answers are never re-sent. `POST /api/v1/support/tickets/:id/auto-reply` re-dispatches a run for an agent; the same hash guard applies.

## Feedback, datasets, and the model registry

Open `/feedback` (or use the API) to run the improvement loop:

1. **Review** proposed corrections / confirmed resolutions with a method (`mistake`, `better_answer`, `denied_outcome`): `PATCH /api/v1/system/candidates/:id`. Reviews are terminal and audited.
2. **Build** a versioned dataset from approved examples: `POST /api/v1/datasets`. Splits are deterministic, time-ordered, stratified by label, and guarded against source-run/duplicate leakage. Rebuilding an unchanged pool returns the same version.
3. **Export** the dataset for training: `GET /api/v1/datasets/:id/export` → `uv run python -m train.linear_probe --dataset-id <id> --register --promote` (see `apps/ai-service/train/README.md`). The trainer writes a portable linear-probe artifact, reports the held-out baseline comparison, and registers/promotes only through the gated API.
4. **Ingest** one canonical eval report (`POST /api/v1/models/eval-reports`) and **promote** only when it passes and does not regress the active baseline: `POST /api/v1/models/:id/promote`. False auto-routing always blocks. The next run forwards the active pointer to the ai-service, so a promoted linear probe serves without a restart; rollback is audited: `POST /api/v1/models/:id/rollback`.
5. **Bless corrections as fixtures** (optional): `pnpm eval:fixtures` writes approved per-category examples to `apps/ai-service/eval/blessed/`; the classification eval merges them into the held-out set.

## Integrations (GitHub + Slack)

Enable the modules in `triage.config.integrations.json` (or copy their `modules.*` entries into your own config) and provide credentials through the environment — never the config file:

```bash
export GITHUB_TOKEN=ghp_...            # comma-separate multiple tokens for rotation
export GITHUB_WEBHOOK_SECRET=...       # signs X-Hub-Signature-256 webhooks
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
TRIAGEAI_CONFIG=triage.config.integrations.json pnpm dev
```

- **GitHub**: routed tickets create one issue (search marker prevents duplicates); `requireApproval` / `approvalCategories` hold actions until an admin approves. Configure the webhook to `POST /api/v1/integrations/github/webhook`; closing the issue resolves the linked ticket, while reopening a resolved ticket is recorded as a conflict instead of an illegal transition.
- **Slack**: P0/P1 or safety-critical tickets go immediately to `criticalChannel`; everything else needs a matching routing rule and is batched by `batchWindowMs`. `dedupeWindowMs` suppresses repeat notifications for the same ticket/channel.
- **Approval/retry**: `/integrations/github` and `/integrations/slack` list action rows; `POST /api/v1/integrations/<provider>/actions/:id/{approve|reject|retry}`. Every suppression, send, failure, and approval writes an `audit_events` row, and an integration outage never changes ticket state.

Outward calls use the `OutputChannel` capability; all adapters pass the same contract suite (`packages/kernel/src/outputChannel/contract.ts`) against local mock servers, so CI needs no live credentials. Phase-8 load results and budgets: `docs/perf/phase8-budget.md`.

`pnpm eval:generation` + `pnpm eval:merge` produce the generation and merged reports locally (CI runs the classifier, retrieval, generation, and merged jobs). The active model pointer is recorded in every run's `decision_records.adapter_versions`.

## Scripts

| Command                    | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `pnpm dev`                 | Run development hosts with reload                    |
| `pnpm test`                | Run TypeScript and Python tests                      |
| `pnpm typecheck`           | Check TypeScript types                               |
| `pnpm lint`                | Run ESLint                                           |
| `pnpm format`              | Run Prettier                                         |
| `pnpm eval:classification` | Run the classifier eval gates                        |
| `pnpm eval:retrieval`      | Run the retrieval eval gates (needs DB + ai-service) |
| `pnpm eval:generation`     | Run the grounding/validation eval gates              |
| `pnpm eval:merge`          | Merge suites into the registry report format         |
| `pnpm eval:fixtures`       | Export approved corrections as blessed fixtures      |
| `pnpm db:generate`         | Generate Drizzle migrations                          |
| `pnpm db:migrate`          | Apply database migrations                            |

## About

**TriageAI** is an open-source project focused on building modular, self-hosted AI automation systems. It prioritizes extensibility, local inference, and transparent decision-making.

Developed and maintained by **Harsh Sanket**.  
**DeepSeek 4.1** was used during development.

## Tech Stack

| Category          | Technologies                                              |
| ----------------- | --------------------------------------------------------- |
| Languages         | TypeScript, Python                                        |
| Frontend          | React 19, Vite                                            |
| Backend           | Node.js, Fastify, FastAPI, Zod                            |
| Database          | PostgreSQL, pgvector, thin SQL adapter (Drizzle optional) |
| AI & ML           | all-MiniLM-L6-v2, Qwen2.5-1.5B via Ollama, LM Studio      |
| Testing           | Vitest, pytest, Playwright, k6                            |
| Infrastructure    | Docker, Docker Compose, Nginx, Prometheus, Grafana        |
| Development Tools | pnpm, uv, ESLint, Prettier                                |

## Sponsor

My open-source work on GitHub is currently supported by [**kumarsidd**](https://github.com/kumarsidd).


All my work is independently developed, and sponsorship does not influence my work, technical decisions, or project direction.

## License

Released under the GNU General Public License v3.0 — see [`LICENSE`](./LICENSE).

---

Proudly made in Mumbai by Harsh Sanket.

a **Harsh Sanket** production.
