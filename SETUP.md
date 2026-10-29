# TriageAI — Setup guide

Everything you need to get TriageAI running, from a one-command Docker demo to a
full local development loop. For what each piece does, see
[FEATURES.md](./FEATURES.md); for the architecture, see
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

> **Coming in Phase 11:** a first-run setup wizard at `/config` that asks which
> knowledge base, LLM and interfaces you want, then configures everything for
> you ([DEVELOPMENT_PLAN.md](./docs/DEVELOPMENT_PLAN.md#phase-11--first-run-setup-wizard-at-config)).
> Until then, setup is the manual process described here.

---

## 1. Prerequisites

| Tool                             | Version  | Needed for                                     |
| -------------------------------- | -------- | ---------------------------------------------- |
| Docker + Compose v2              | recent   | Postgres (always), and the containerised stack |
| Node.js                          | ≥ 20     | API + web development                          |
| pnpm                             | 12.x     | Monorepo workspaces (`corepack enable` works)  |
| Python                           | ≥ 3.12   | `apps/ai-service` (embeddings/classification)  |
| [uv](https://docs.astral.sh/uv/) | recent   | Python env + dependency management             |
| [Ollama](https://ollama.com)     | optional | Local LLM (or use the `llm` compose profile)   |
| [LM Studio](https://lmstudio.ai) | optional | Alternative local LLM (OpenAI-compatible API)  |

Hardware: 8 GB RAM runs the `core` and `support` profiles; generation with a
1.5B model wants ~4 GB extra; 16 GB is comfortable for the `full` profile.
Apple Silicon and x86-64 are both supported (images build for arm64 and amd64).

---

## 2. Pick what you want to run

TriageAI is one kernel plus modules you turn on in a JSON config. Choose a
config file and point `TRIAGEAI_CONFIG` at it:

| Config file                             | What you get                                       | Needs ai-service | Needs LLM |
| --------------------------------------- | -------------------------------------------------- | :--------------: | :-------: |
| `triage.config.json` (default)          | Kernel + `echo` demo module                        |        –         |     –     |
| `config/presets/support.json`           | Ticket classification + routing + human review     |        ✓         |     –     |
| `config/presets/support-autoreply.json` | Support + KB-grounded, validated auto-replies      |        ✓         |     ✓     |
| `config/presets/assistant.json`         | Grounded chat over your KB + doc-assistant         |        ✓         |     ✓     |
| `config/presets/integrations.json`      | Support + GitHub issues + Slack notifications      |        ✓         | optional  |
| `config/presets/full.json`              | Support + chat + KB + doc-assistant in one process |        ✓         |     ✓     |

Enabling or disabling a module is a config change plus a restart — the web UI
only shows modules the API reports as enabled.

---

## 3. Quick start with Docker only

```bash
git clone <repo-url> TriageAI && cd TriageAI
docker compose --profile core up --build
```

- Web: <http://localhost:5173> · API: <http://localhost:3000> · health: `/healthz`, `/readyz`
- Migrations run automatically when the API boots.

Add services with more profiles:

```bash
docker compose --profile core --profile ai up --build    # + ai-service (embeddings/classifier)
docker compose --profile llm up -d                        # + Ollama
docker exec triageai-ollama ollama pull qwen2.5:1.5b      # download a model once
TRIAGEAI_CONFIG=/app/config/presets/full.json docker compose --profile core --profile llm up --build
docker compose --profile observ up -d                     # Prometheus :9090, Grafana :3310
docker compose --profile train run --rm trainer ...       # optional classifier trainer
```

Inside the containers the presets live at `/app/config/presets/*.json`; your own `triage.config.json` is `/app/triage.config.json`. A `TRIAGEAI_CONFIG` path is resolved from the repo root, and boot fails if it doesn't exist.

### Network exposure (read this before sharing a machine)

All published ports bind to **127.0.0.1** by default, because the default stack
runs with `AUTH_MODE=disabled` (every request is treated as an admin) and a
fixed Postgres password. To expose TriageAI on your LAN:

```bash
export TRIAGEAI_BIND=0.0.0.0
export AUTH_MODE=required
export AUTH_JWT_SECRET="$(openssl rand -hex 32)"
export CORS_ORIGINS=https://triage.example.internal
docker compose --profile core up --build
```

Then register the first user (it becomes admin; registration closes
afterwards): `POST /api/v1/auth/register` or the web login screen.

---

## 4. Local development setup

```bash
pnpm install
uv --directory apps/ai-service sync --extra dev
cp apps/api/.env.example apps/api/.env
cp apps/ai-service/.env.example apps/ai-service/.env
docker compose up -d postgres          # the only mandatory infrastructure
pnpm dev                               # api :3000 + web :5173 with hot reload
```

The Vite dev server proxies `/api` to `localhost:3000`. Pick a profile with
`TRIAGEAI_CONFIG=config/presets/full.json pnpm dev`.

### AI service (embeddings + classification)

```bash
uv --directory apps/ai-service run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The first start downloads `all-MiniLM-L6-v2` (~90 MB) into the Hugging Face
cache (`HF_HOME`, a Docker volume in compose). Set `EMBEDDING_MODEL` to change
it — model names are config, never code (ADR-0008).

### Local LLM

Ollama (default adapter):

```bash
ollama pull qwen2.5:1.5b               # or: docker compose --profile llm up -d
```

LM Studio / any OpenAI-compatible server — set the generator in your config:

```json
"generator": { "adapter": "lmstudio", "baseUrl": "http://localhost:1234/v1", "model": "<model-id>" }
```

`TRIAGEAI_GENERATOR_BASE_URL` overrides `baseUrl` without editing the file
(e.g. `http://host.docker.internal:11434` when the API runs in Docker and Ollama on the host).

### Seed demo data

```bash
pnpm seed:demo                          # after /readyz is green; TOKEN=... when auth is on
```

---

## 5. Environment variables

### API (`apps/api/.env`)

| Variable                      | Default                                       | Purpose                                                         |
| ----------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`                | — (required)                                  | Postgres connection string                                      |
| `PORT`                        | `3000`                                        | API port                                                        |
| `NODE_ENV`                    | `development`                                 | `production` makes `AUTH_MODE` default to `required`            |
| `TRIAGEAI_CONFIG`             | `./triage.config.json`                        | Which module/capability config to load                          |
| `AI_SERVICE_URL`              | `http://localhost:8000`                       | Python ai-service base URL                                      |
| `TRIAGEAI_GENERATOR_BASE_URL` | from config                                   | Override the LLM endpoint                                       |
| `AUTH_MODE`                   | `disabled` (dev) / `required` (prod)          | Identity + RBAC on/off                                          |
| `AUTH_JWT_SECRET`             | —                                             | ≥ 32 chars; required when auth is on                            |
| `AUTH_ACCESS_TTL_SECONDS`     | `900`                                         | Access token lifetime                                           |
| `AUTH_REFRESH_TTL_SECONDS`    | `2592000`                                     | Refresh token lifetime                                          |
| `METRICS_TOKEN`               | —                                             | Bearer token Prometheus uses for `GET /metrics` when auth is on |
| `CORS_ORIGINS`                | `http://localhost:5173,http://127.0.0.1:5173` | Browser origins allowed to call the API (`*` = any; unsafe)     |
| `RATE_LIMIT_MAX` / `_WINDOW`  | `300` / `1 minute`                            | Global per-IP rate limit                                        |
| `TRIAGEAI_ENABLE_MODULES`     | —                                             | Comma list; force-enable modules over the config file           |
| `TRIAGEAI_DISABLE_MODULES`    | —                                             | Comma list; force-disable modules                               |
| `TRIAGEAI_QUEUE_ADAPTER`      | from config                                   | `pg-queue` (default) or `inline` (`bullmq` is not built yet)    |
| `GITHUB_TOKEN`                | —                                             | GitHub integration (comma-separate for rotation)                |
| `GITHUB_WEBHOOK_SECRET`       | —                                             | Verifies `X-Hub-Signature-256`                                  |
| `SLACK_WEBHOOK_URL`           | —                                             | Slack integration                                               |

### ai-service (`apps/ai-service/.env`)

| Variable               | Default            | Purpose                                       |
| ---------------------- | ------------------ | --------------------------------------------- |
| `EMBEDDING_MODEL`      | `all-MiniLM-L6-v2` | Sentence-transformers model id                |
| `EMBEDDING_DEVICE`     | `cpu`              | `cpu`, `cuda`, or `mps`                       |
| `CLASSIFIER_THRESHOLD` | `0.35`             | Similarity floor for a confident category     |
| `CLASSIFIER_MARGIN`    | `0.05`             | Required gap between the top two categories   |
| `ARTIFACTS_DIR`        | `artifacts`        | Root for trained classifier artifacts         |
| `PRELOAD_MODEL`        | `true`             | Load weights at boot instead of first request |
| `HF_HOME`              | HF default         | Hugging Face model cache directory            |

### Compose-only

| Variable        | Default     | Purpose                                      |
| --------------- | ----------- | -------------------------------------------- |
| `TRIAGEAI_BIND` | `127.0.0.1` | Host interface every published port binds to |

---

## 6. Verify your setup

```bash
curl -s localhost:3000/healthz                       # {"status":"ok",...}
curl -s localhost:3000/readyz                        # {"status":"ready"}
curl -s localhost:3000/api/v1/system/manifest        # the modules you enabled
curl -s localhost:8000/ai/v1/health                  # ai-service (if running)
```

Then open the web app; the header shows exactly the enabled modules.

## 7. Run the checks

```bash
pnpm lint && pnpm typecheck && pnpm test:ts && pnpm format:check
pnpm test:python                                     # if you touched apps/ai-service
SKIP_DB_TESTS=1 pnpm test:ts                         # without Postgres
```

DB-backed suites use `DATABASE_URL` (default
`postgres://triageai:triageai@localhost:5432/triageai`). **Stop `pnpm dev`
first** — a running API shares the queue and steals workflow jobs from tests.

## 8. Troubleshooting

| Symptom                                               | Fix                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Invalid environment configuration: DATABASE_URL`     | Copy `apps/api/.env.example` to `apps/api/.env`                                       |
| `kernel.BOOT_VALIDATION_FAILED … requires capability` | Your config enables a module whose capability (embedder, generator…) isn't configured |
| `queue adapter "bullmq" is not implemented yet`       | Use `"pg-queue"` in `queue.adapter`                                                   |
| `core migration …: checksum` on boot                  | A migration was edited; migrations are immutable — reset the dev DB volume            |
| Chat always says "could not verify"                   | Add and **approve** documents in `/kb`; check `/runs` for the retrieval gate          |
| API in Docker can't reach Ollama on the host          | `TRIAGEAI_GENERATOR_BASE_URL=http://host.docker.internal:11434`                       |
| Port 3000/5432 already in use                         | Stop the other process, or change the left side of the compose port mapping           |
| Tests fail intermittently on workflow jobs            | Stop `pnpm dev`, or point tests at a dedicated database                               |

## 9. Operations

Backup/restore, upgrades and retention live in
[docs/OPERATIONS.md](./docs/OPERATIONS.md) (`scripts/backup.sh`,
`scripts/restore.sh`).
