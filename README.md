# TriageAI

> **v1.2.0** — knowledge-base data-processing controls with per-source extraction, chunking and storage provenance; a skills drawer and refreshed chat home; model-runtime switches; and redesigned feedback and run summaries.

A **modular, self-hosted AI automation platform** built around interchangeable components and configurable workflows.

TriageAI combines classification, retrieval, generation, validation, and human review into composable workflows. Capabilities are replaceable independently, every decision is inspectable, and inference stays local.

## Configurations

- **`support`** — Ticket classification, routing, human review, and a typed ticket state machine.
- **`support-autoreply`** — Support plus KB-grounded auto-reply with validation, fallbacks, and customer confirmation.
- **`assistant`** — KB-grounded chat and a doc-assistant that answers from this repository's `docs/**` with file-path citations.
- **`chat-only`** — The chat surface without a knowledge base.
- **`full`** — Support + chat + KB + doc-assistant + data extraction in one process (the easiest way to see everything).
- **`public-api`** — Scoped API keys with an OpenAI-compatible chat/embeddings surface.
- **`emailer`** — Support plus inbound email and approval-gated outbound replies.
- **`integrations`** — Support plus optional GitHub/Slack outward actions (`config/presets/integrations.json`); enable/disable and credentials stay config/env-only.
- **`core`** — Minimal kernel and application hosts for custom workflows.

## Repository Layout

```text
packages/
  kernel/        # Boot, config, module graph, events, workflows, queues, decision records,
                 #   grants, module protocol, agents, tools, skills, memory, data policy
  contracts/     # Shared Zod DTOs (feedback/datasets/models/agents/jobs/errors) → JSON Schema
  rag/           # Prompt boundaries, chunking, grounding, deterministic validation
  plugin-sdk/    # Manifest, signing and install helpers for runtime plugins
  integrations-core/  # Audited action rows + approve/reject/retry routes for integrations
apps/
  web/           # React host (chat home, module pages, dashboard, inspector, /config)
  api/           # Fastify host (system, dashboard, setup, model registry, public API)
  ai-service/    # Optional Python inference service + eval/ + train/ (CPU seed)
modules/         # Replaceable first-party modules
  integrations-github/  # github-issue OutputChannel, approval gates, webhook sync
  integrations-slack/   # slack-message OutputChannel, routing/batching/dedupe
  support/ · kb/ · chat/ · ai-pipeline/ · doc-assistant/ · data-extract/
  public-api/ · emailer/ · llm-local/ · classifier-provider/ · embedder-provider/ · echo/
perf/k6/          # ingest/drain, burst/fairness/hot-swap, module-failure suites
config/presets/   # Starting configs: support, support-autoreply, assistant, chat-only,
                  #   full, public-api, emailer, integrations
scripts/          # backup/restore, demo seed, new-module scaffold, docs-workflow
```

Step-by-step setup (every profile, env var, and troubleshooting tip): [SETUP.md](./SETUP.md). Feature inventory: [FEATURES.md](./FEATURES.md). Project map: [WORKFLOW.md](./WORKFLOW.md).

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
TRIAGEAI_CONFIG=config/presets/full.json pnpm dev
```

Open:

- `http://localhost:5173/` — grounded chat over the KB (`/?c=<id>` reopens a conversation)
- `http://localhost:5173/support` — tickets + auto-reply + confirmation
- `http://localhost:5173/kb` — add, import, enable, and delete knowledge sources
- `http://localhost:5173/data-extract` — turn CSV/XLSX/PDF files into queryable datasets
- `http://localhost:5173/doc-assistant` — ask about this repo's docs
- `http://localhost:5173/runs` — inspector with stage timelines and decision records
- `http://localhost:5173/feedback` — feedback insights, review queue, datasets, model registry
- `http://localhost:5173/dashboard` — health, activity, knowledge, security, usage, storage
- `http://localhost:5173/config` — setup wizard while pending, then settings

The chat is **grounded by default**: answers cite enabled KB sources. With `knowledgeMode: "prefer"` (the default) it labels an ungrounded answer as general; set `knowledgeMode: "only"` to refuse instead ("I could not verify this from the knowledge base."). Add sources in `/kb`; if a question looks wrong, check `/runs` for retrieval and validation decisions.

Operations surfaces: workflow inspector at `/runs`, admin dashboard at `/dashboard`, Prometheus metrics at `/metrics`, and the optional observability stack via `docker compose --profile observ up -d` (Prometheus `:9090`, Grafana `:3310`).

Assistant profile (KB + retrieval + local generation): first download a model into the local runtime, then start the assistant stack:

```bash
docker compose --profile llm up -d
docker exec triageai-ollama ollama pull qwen2.5:1.5b
TRIAGEAI_CONFIG=/app/config/presets/assistant.json docker compose --profile core up --build
```

Open `/kb` to add and enable documents, then `/` to ask grounded questions (answers cite their sources). `TRIAGEAI_CONFIG=/app/config/presets/assistant.json` points the API at the assistant module set; without it the default core profile runs.

Run everything together (support + chat + KB + doc-assistant + data extraction) with `TRIAGEAI_CONFIG=/app/config/presets/full.json`; answers use enabled knowledge by default and label general answers when nothing relevant is enabled.

Generator address: configs point at `http://localhost:11434` for host-run dev. The API container defaults to `http://ollama:11434`; set `TRIAGEAI_GENERATOR_BASE_URL` to override (e.g. `http://host.docker.internal:11434` for an Ollama on the host, or any remote runtime).

Support profile (classification + routing, **no LLM**): start the AI service and point the API at the support config:

```bash
docker compose --profile core --profile ai up --build
# or, with a host ai-service:
TRIAGEAI_CONFIG=/app/config/presets/support.json AI_SERVICE_URL=http://host.docker.internal:8000 \
  docker compose --profile core up --build
```

Then open `/support` in the web app and create a ticket — it is classified, routed, and (for security/unknown cases) escalated to human review.

Support auto-reply profile (classification + routing + KB + local generation): same AI service and model, but retrieval and a local generator are enabled so routed tickets can receive a grounded answer:

```bash
docker compose --profile llm up -d
docker exec triageai-ollama ollama pull qwen2.5:1.5b
TRIAGEAI_CONFIG=/app/config/presets/support-autoreply.json docker compose --profile core up --build
```

Auto-reply is per-category and versioned (`GET/PUT /api/v1/support/auto-reply-policies`): disable it for a category and the **next** ticket escalates without a deploy. Replies move the ticket to `AWAITING_CUSTOMER`; `POST /api/v1/support/tickets/:id/confirmation` with `{ "solved": true | false }` resolves or escalates, and identical failed answers are never re-sent. `POST /api/v1/support/tickets/:id/auto-reply` re-dispatches a run for an agent; the same hash guard applies.

## Knowledge, memory, and data

- **Knowledge base** (`kb`) ingests PDF, DOCX, XLSX, CSV, Markdown, text, HTML, URLs, GitHub repositories and notes. Every source has an On/Off switch (On means used), labels, search and storage totals; identical content is deduplicated, and deleting a source removes its chunks, vectors and stored original.
- **Data processing** is configurable per new source: chunking presets (structure-aware 700/1,200, sentence 500, fixed 1,000), PDF extraction (text layer or strict text layer; OCR when the optional AI-service adapter is installed) and image extraction. The KB source list shows the chunking, extraction and storage backends each source actually used, and `/config` explains which strategy fits which corpus.
- **Base memory** is generated from setup as managed `base-memory.public` / `base-memory.operator` KB sources. Customer surfaces (chat, support, public API) retrieve public entries only; operator surfaces see both. An operational `system-status` snapshot backs read-only `system.get_status/get_uptime/get_storage` tools.
- **Data extraction** (`data-extract`) turns CSV/XLSX/PDF files into typed `transactions` or `generic-table` datasets with deterministic mapping, saved confirmations and user rules. A balance reconciliation gate keeps `needs_review` rows out of charts; dataset views (totals, categories, months, merchants, rows) can be pinned, and a fixed-schema `data_extract.query_dataset` tool is restricted by default.

## Agents, tools, and skills

- **Tools** use one mandatory contract with read/write and low/high-risk labels, a rule floor, undo class and preview checks; high-risk calls are gated.
- **Skills** follow the Agent Skills format: frontmatter index, lazy body loading and path-traversal guards. User skills are owner-scoped, can be enabled/disabled, imported from GitHub with pin/ETag, or suggested from chat; enabled skills are mirrored into the KB as read-only operator sources.
- The agent runtime's checkpointed state, need-based context, structured handoffs, shared work board and long-term memory are landing across Phases 15–17; the contracts and stores are in place, with the full agent loop still in progress.

## Models and runtime control

- **Hosted LLM APIs** (Anthropic, OpenAI, Google and any OpenAI-compatible host) are opt-in per workload with an egress gate, redaction, daily budgets and a cost ledger; local inference remains the default.
- **Model runtimes** can be listed and switched at runtime, with a global LLM kill switch and per-runtime On/Off enforced before network or cache paths.
- **Chat context** is assembled by one shared packer with a per-call token budget, high-water compaction, a durable versioned summary, a deterministic outage fallback, and a composer ring showing used/total tokens.

## Plugins and module isolation

Runtime plugins are signed `.tgz` packages verified with ed25519 + sha256; install, enable, disable and uninstall are admin actions, and installs hot-swap a kernel generation. Modules declare permission manifests (routes, events, capabilities, stages, workflows, tools, egress, knowledge) with default-deny grants, and own a `mod_<id>` Postgres schema. Container modules speak the MP1 protocol (strict envelope, replay/deadline checks, broker authorization); `echo` is the reference implementation and runs under the `modules` compose profile. Packs and Stage-B container certificates are still partial — see [FEATURES.md](./FEATURES.md).

## Public API and email

- **`public-api`** issues hashed, scoped API keys and exposes OpenAI-compatible `/v1/chat/completions` and `/v1/embeddings`, plus KB search, so other apps and agents can use TriageAI as a backend.
- **`emailer`** accepts a signed inbound webhook, threads replies into tickets and sends approval-gated outbound mail through an SMTP outbox. IMAP polling is still planned.

## Feedback, datasets, and the model registry

Open `/feedback` (or use the API) to run the improvement loop:

1. **Review** proposed corrections / confirmed resolutions with a method (`mistake`, `better_answer`, `denied_outcome`): `PATCH /api/v1/system/candidates/:id`. Reviews are terminal and audited.
2. **Build** a versioned dataset from approved examples: `POST /api/v1/datasets`. Splits are deterministic, time-ordered, stratified by label, and guarded against source-run/duplicate leakage. Rebuilding an unchanged pool returns the same version.
3. **Export** the dataset for training: `GET /api/v1/datasets/:id/export` → `uv run python -m train.linear_probe --dataset-id <id> --register --promote` (see `apps/ai-service/train/README.md`). The trainer writes a portable linear-probe artifact, reports the held-out baseline comparison, and registers/promotes only through the gated API.
4. **Ingest** one canonical eval report (`POST /api/v1/models/eval-reports`) and **promote** only when it passes and does not regress the active baseline: `POST /api/v1/models/:id/promote`. False auto-routing always blocks. The next run forwards the active pointer to the ai-service, so a promoted linear probe serves without a restart; rollback is audited: `POST /api/v1/models/:id/rollback`.
5. **Bless corrections as fixtures** (optional): `pnpm eval:fixtures` writes approved per-category examples to `apps/ai-service/eval/blessed/`; the classification eval merges them into the held-out set.

## Integrations (GitHub + Slack)

Enable the modules in `config/presets/integrations.json` (or copy their `modules.*` entries into your own config) and provide credentials through the environment — never the config file:

```bash
export GITHUB_TOKEN=ghp_...            # comma-separate multiple tokens for rotation
export GITHUB_WEBHOOK_SECRET=...       # signs X-Hub-Signature-256 webhooks
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
TRIAGEAI_CONFIG=config/presets/integrations.json pnpm dev
```

- **GitHub**: routed tickets create one issue (search marker prevents duplicates); `requireApproval` / `approvalCategories` hold actions until an admin approves. Configure the webhook to `POST /api/v1/integrations/github/webhook`; closing the issue resolves the linked ticket, while reopening a resolved ticket is recorded as a conflict instead of an illegal transition.
- **Slack**: P0/P1 or safety-critical tickets go immediately to `criticalChannel`; everything else needs a matching routing rule and is batched by `batchWindowMs`. `dedupeWindowMs` suppresses repeat notifications for the same ticket/channel.
- **Approval/retry**: `/integrations/github` and `/integrations/slack` list action rows; `POST /api/v1/integrations/<provider>/actions/:id/{approve|reject|retry}`. Every suppression, send, failure, and approval writes an `audit_events` row, and an integration outage never changes ticket state.

Outward calls use the `OutputChannel` capability; all adapters pass the same contract suite (`packages/kernel/src/outputChannel/contract.ts`) against local mock servers, so CI needs no live credentials. Phase-8 load results and budgets: `docs/perf/phase8-budget.md`.

`pnpm eval:generation` + `pnpm eval:merge` produce the generation and merged reports locally (CI runs the classifier, retrieval, generation, and merged jobs). The active model pointer is recorded in every run's `decision_records.adapter_versions`.

## Dashboard, setup, and operations

- `/dashboard` consolidates health, activity, knowledge, security, token usage, performance (tokens/s, TTFT), uptime, storage, machine, dead letters and connected APIs. Graphs support day/month/year/custom ranges; the refresh interval is configurable (default 10 min).
- `/config` is the first-run wizard and then the settings home. Answers are written as a versioned, audited overlay above the config file and below environment variables, so secrets stay out of files. It also covers connected APIs (add/test/rotate/disable/remove), knowledge data-processing strategies, per-class data policy with named presets, model runtimes, skills, and appearance (Light/Dark/Auto, four font sizes, animations, agent names and colours).
- Setup is exact scoped: add or remove interfaces, or run **Reset** / **Reset and erase** from the danger zone. Applied changes are audited and restart-time unless they use a supported hot-reload path.
- Long jobs (knowledge ingestion, datasets) report progress, ETA and cancel in the notification tray, and the tray survives a reload.
- [WORKFLOW.md](./WORKFLOW.md) is the committed project map; `pnpm docs:workflow` regenerates its tables and CI fails on drift, a missing section, or a line-budget breach.

## Scripts

| Command                    | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `pnpm dev`                 | Run development hosts with reload                    |
| `pnpm build`               | Build the web and API apps                           |
| `pnpm test`                | Run TypeScript and Python tests                      |
| `pnpm test:python`         | Run the Python inference-service tests               |
| `pnpm typecheck`           | Check TypeScript types                               |
| `pnpm lint`                | Run ESLint                                           |
| `pnpm format`              | Run Prettier                                         |
| `pnpm eval:classification` | Run the classifier eval gates                        |
| `pnpm eval:retrieval`      | Run the retrieval eval gates (needs DB + ai-service) |
| `pnpm eval:generation`     | Run the grounding/validation eval gates              |
| `pnpm eval:merge`          | Merge suites into the registry report format         |
| `pnpm eval:fixtures`       | Export approved corrections as blessed fixtures      |
| `pnpm seed:demo`           | Seed demo KB docs + a ticket (after `readyz`)        |
| `pnpm docs:workflow`       | Regenerate `WORKFLOW.md` generated tables            |
| `pnpm docs:workflow:check` | Fail when `WORKFLOW.md` drifts from the code         |

## About

**TriageAI** is an open-source project focused on building modular, self-hosted AI automation systems. It prioritizes extensibility, local inference, and transparent decision-making.

Current release: **v1.2.0**.

Developed and maintained by **Harsh Sanket**.  
**DeepSeek 4.1** was used during development.

## Tech Stack

| Category          | Technologies                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Languages         | TypeScript, Python                                                                                              |
| Frontend          | React 19, Vite                                                                                                  |
| Backend           | Node.js, Fastify, FastAPI, Zod                                                                                  |
| Database          | PostgreSQL, pgvector, schema-per-module storage, migrations on boot                                             |
| AI & ML           | sentence-transformers (MiniLM default), Qwen2.5-1.5B via Ollama, LM Studio, hosted Anthropic/OpenAI/Google APIs |
| Testing           | Vitest, pytest, Playwright, k6                                                                                  |
| Infrastructure    | Docker, Docker Compose, Nginx, Prometheus, Grafana                                                              |
| Development Tools | pnpm, uv, ESLint, Prettier                                                                                      |

## License

Released under the GNU General Public License v3.0 — see [`LICENSE`](./LICENSE).

---

Proudly made in Mumbai by Harsh Sanket.

a **Harsh Sanket** production.
