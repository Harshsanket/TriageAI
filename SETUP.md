# TriageAI — Setup guide

Everything you need to get TriageAI running, from a one-command Docker demo to a
full local development loop. A fresh install is configured in the browser at
`/config`; file/env configuration remains available for scripted deployments.
For what each piece does, see [FEATURES.md](./FEATURES.md); for the architecture,
see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

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

## 2. First run: the `/config` wizard

A **fresh database** (one that has never booted TriageAI) starts in setup mode.
Until setup is applied the API answers only `/healthz`, `/readyz` and
`/api/v1/setup/*`; every other request gets `409 setup.REQUIRED`, and the web
app shows the wizard instead of the normal shell.

1. Start the stack. On first boot the API prints a one-time token:

   ```
   TriageAI first-run setup
   Open the web app and go to /config, then paste this setup token:
       <token>
   ```

   In Docker: `docker compose logs api`. With `pnpm dev`: the terminal running
   the API. The token changes on every restart and stops working once setup is
   applied.

2. Open <http://localhost:5173/config> (or the web container's URL), paste the
   token, and answer the steps:
   - **Machine check** — RAM, CPU, GPU/VRAM, free disk, model budget, and whether
     the ai-service and Ollama are reachable. The budget drives the model fit
     verdicts.
   - **Interfaces** — Chatbot, Ticket solver, Doc assistant, GitHub/Slack
     notifications. The plan resolves the modules and capabilities they need;
     API/emailer interfaces are marked coming soon (Phase 13).
   - **Base knowledge** — upload `.md`, `.txt` or `.html` (up to 50 files,
     200 KB each) and choose whether to auto-approve them. Files are queued and
     imported by the KB module after the restart. PDF/DOCX/URL/folder imports
     are not implemented yet.
   - **Language model** — pick a runtime (Ollama, LM Studio, another
     OpenAI-compatible URL, or none), then a recommended model for your tier,
     search Hugging Face, or type a runtime model name. Ollama downloads stream
     progress to the page; other runtimes show the command to run. "Test the
     model" performs one real generation.
   - **Access & accounts** — sign-in off (single-user local instance) or on with
     roles, plus the first admin account. With sign-in on the wizard generates
     and stores a JWT secret when the secret store is available.
   - **Review & apply** — the modules, model, document count, secrets and the
     exact config overlay; blocking problems disable Apply.

3. Apply. The answers are saved as a new **config overlay** version; nothing is
   written to `triage.config.json`. The API must boot with the new config:
   - Docker Compose sets `TRIAGEAI_RESTART_ON_APPLY=1` and
     `restart: unless-stopped`, so the API exits and is restarted automatically.
   - With `pnpm dev` there is no supervisor: stop and start `pnpm dev`. The page
     says so while `setup.state = applied`.

   If the new config fails to boot, the API re-writes the previous overlay as a
   new version, returns to setup mode with the error on `/config`, and exits; the
   next start runs the last good configuration.

4. After setup, `/config` is the settings page: running profile, enabled modules,
   model, auth mode and its source, overlay history, and stored secret names.
   "Change setup" reopens the wizard; each apply writes a new overlay version and
   an audit row.

What lives where:

| Item                                                  | Storage                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| Answers / config overlay                              | `config_overlays` (versioned, audited)                      |
| Setup state, draft, last error, auth mode             | `settings` (`setup.*`, `host.authMode`)                     |
| Credentials (GitHub token, Slack webhook, JWT secret) | `secrets`, AES-256-GCM encrypted with `TRIAGEAI_SECRET_KEY` |
| Uploaded documents                                    | `setup_imports`, imported into the KB after boot            |

**Existing installs** (the database has booted before) are treated as already
set up — no wizard appears and behavior is unchanged. Open `/config` to review or
change the current answers. `TRIAGEAI_SETUP=off` disables the wizard entirely for
env/file-driven deployments.

### Network exposure (read this before sharing a machine)

All published ports bind to **127.0.0.1** by default. An instance with sign-in
off treats every request as an admin, and the default Postgres password is
fixed; only expose TriageAI beyond loopback with authentication on.

The wizard asks for the auth mode, so the normal path is: keep the ports on
loopback while you finish setup, choose "People sign in", then rebind. To pin
the choice in the environment (it overrides the wizard):

```bash
export TRIAGEAI_BIND=0.0.0.0
export AUTH_MODE=required
export AUTH_JWT_SECRET="$(openssl rand -hex 32)"
export CORS_ORIGINS=https://triage.example.internal
export TRIAGEAI_SECRET_KEY="$(openssl rand -hex 32)"
docker compose --profile core up --build
```

The first account created becomes admin; registration closes afterwards.
`AUTH_MODE` unset means: chosen in `/config`, otherwise `disabled` in
development and `required` in production.

---

## 3. Pick what you want to run (file/env deployments)

The wizard writes an overlay, so you do not need a config file for a normal
install. Scripted deployments can still choose a starting config and point
`TRIAGEAI_CONFIG` at it (the overlay, if any, then layers on top):

| Config file                             | What you get                                       | Needs ai-service | Needs LLM |
| --------------------------------------- | -------------------------------------------------- | :--------------: | :-------: |
| `triage.config.json` (default)          | Kernel + `echo` demo module                        |        –         |     –     |
| `config/presets/support.json`           | Ticket classification + routing + human review     |        ✓         |     –     |
| `config/presets/support-autoreply.json` | Support + KB-grounded, validated auto-replies      |        ✓         |     ✓     |
| `config/presets/assistant.json`         | Grounded chat over your KB + doc-assistant         |        ✓         |     ✓     |
| `config/presets/integrations.json`      | Support + GitHub issues + Slack notifications      |        ✓         | optional  |
| `config/presets/full.json`              | Support + chat + KB + doc-assistant in one process |        ✓         |     ✓     |

Enabling or disabling a module is a config change plus a restart — the web UI
only shows modules the API reports as enabled. The wizard's overlay takes
precedence over the file; `TRIAGEAI_ENABLE_MODULES` / `TRIAGEAI_DISABLE_MODULES`
take precedence over both.

---

## 4. Quick start with Docker only

```bash
git clone <repo-url> TriageAI && cd TriageAI
export TRIAGEAI_SECRET_KEY="$(openssl rand -hex 32)"   # optional; otherwise a key file is generated
docker compose --profile core up --build
```

- Web: <http://localhost:5173> · API: <http://localhost:3000> · health: `/healthz`, `/readyz`
- Migrations run automatically when the API boots.
- The first-boot setup token is in `docker compose logs api`; finish at `/config`
  (see §2). Compose restarts the API automatically after Apply.
- `TRIAGEAI_SECRET_KEY` is optional: without it (32+ chars) the wizard disables
  credential fields and you set `GITHUB_TOKEN` / `SLACK_WEBHOOK_URL` in the
  environment instead. Keep the key out of the database and backups.

Add services with more profiles:

```bash
docker compose --profile core --profile ai up --build    # + ai-service (embeddings/classifier)
docker compose --profile llm up -d                        # + Ollama
docker exec triageai-ollama ollama pull qwen2.5:1.5b      # manual model download (the wizard can do it)
TRIAGEAI_CONFIG=/app/config/presets/full.json docker compose --profile core --profile llm up --build
docker compose --profile observ up -d                     # Prometheus :9090, Grafana :3310
docker compose --profile train run --rm trainer ...       # optional classifier trainer
```

Inside the containers the presets live at `/app/config/presets/*.json`; your own `triage.config.json` is `/app/triage.config.json`. A `TRIAGEAI_CONFIG` path is resolved from the repo root, and boot fails if it doesn't exist.

---

## 5. Local development setup

```bash
pnpm install
uv --directory apps/ai-service sync --extra dev
cp apps/api/.env.example apps/api/.env
cp apps/ai-service/.env.example apps/ai-service/.env
docker compose up -d postgres          # the only mandatory infrastructure
pnpm dev                               # api :3000 + web :5173 with hot reload
```

The Vite dev server proxies `/api` to `localhost:3000`. A fresh database starts
the wizard: copy the token from the API terminal, open
<http://localhost:5173/config>, and restart `pnpm dev` when Apply asks you to.
Uncomment `TRIAGEAI_SECRET_KEY` in `apps/api/.env` to store credentials from
the wizard. Pick a file/profile instead with
`TRIAGEAI_CONFIG=config/presets/full.json pnpm dev` (existing databases skip the
wizard).

### AI service (embeddings + classification)

```bash
uv --directory apps/ai-service run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The first start downloads `all-MiniLM-L6-v2` (~90 MB) into the Hugging Face
cache (`HF_HOME`, a Docker volume in compose). Set `EMBEDDING_MODEL` to change
it — model names are config, never code (ADR-0008). The wizard shows the
embedding model as information because the ai-service owns it.

### Local LLM

Ollama (default adapter):

```bash
ollama pull qwen2.5:1.5b               # or: docker compose --profile llm up -d
```

The wizard can download Ollama models for you. LM Studio / any
OpenAI-compatible server — set the generator in your config (or choose it in
the wizard):

```json
"generator": { "adapter": "lmstudio", "baseUrl": "http://localhost:1234/v1", "model": "<model-id>" }
```

`TRIAGEAI_GENERATOR_BASE_URL` overrides `baseUrl` without editing the file
(e.g. `http://host.docker.internal:11434` when the API runs in Docker and Ollama on the host). The wizard warns when this env override will shadow its choice.

### Seed demo data

```bash
pnpm seed:demo                          # after /readyz is green; TOKEN=... when auth is on
```

---

## 6. Environment variables

### API (`apps/api/.env`)

| Variable                      | Default                                                  | Purpose                                                                   |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`                | — (required)                                             | Postgres connection string                                                |
| `PORT`                        | `3000`                                                   | API port                                                                  |
| `NODE_ENV`                    | `development`                                            | `production` makes the unset auth mode default to `required`              |
| `TRIAGEAI_CONFIG`             | `./triage.config.json`                                   | Base module/capability config (the `/config` overlay layers above it)     |
| `TRIAGEAI_SETUP`              | `auto`                                                   | `off` disables the first-run wizard (existing-file/env deployments)       |
| `TRIAGEAI_SECRET_KEY`         | generated at `$TRIAGEAI_SECRETS_DIR/master.key`          | 32+ chars; optional env override for the encrypted `/config` secret store |
| `TRIAGEAI_RESTART_ON_APPLY`   | unset (`0`)                                              | `1` exits the API after Apply so a supervisor boots the new config        |
| `AI_SERVICE_URL`              | `http://localhost:8000`                                  | Python ai-service base URL                                                |
| `TRIAGEAI_GENERATOR_BASE_URL` | from config                                              | Override the LLM endpoint (wins over the wizard)                          |
| `AUTH_MODE`                   | unset → `/config`, else dev `disabled` / prod `required` | Pin identity + RBAC on/off; env wins over the wizard                      |
| `AUTH_JWT_SECRET`             | auto-generated by the wizard when auth is on             | ≥ 32 chars; required when auth is on and the secret store is off          |
| `AUTH_ACCESS_TTL_SECONDS`     | `900`                                                    | Access token lifetime                                                     |
| `AUTH_REFRESH_TTL_SECONDS`    | `2592000`                                                | Refresh token lifetime                                                    |
| `METRICS_TOKEN`               | —                                                        | Bearer token Prometheus uses for `GET /metrics` when auth is on           |
| `CORS_ORIGINS`                | `http://localhost:5173,http://127.0.0.1:5173`            | Browser origins allowed to call the API (`*` = any; unsafe)               |
| `RATE_LIMIT_MAX` / `_WINDOW`  | `300` / `1 minute`                                       | Global per-IP rate limit                                                  |
| `TRIAGEAI_ENABLE_MODULES`     | —                                                        | Comma list; force-enable modules over file and overlay                    |
| `TRIAGEAI_DISABLE_MODULES`    | —                                                        | Comma list; force-disable modules                                         |
| `TRIAGEAI_QUEUE_ADAPTER`      | from config                                              | `pg-queue` (default) or `inline` (`bullmq` is not built yet)              |
| `GITHUB_TOKEN`                | —                                                        | GitHub integration (comma-separate for rotation); env wins over `/config` |
| `GITHUB_WEBHOOK_SECRET`       | —                                                        | Verifies `X-Hub-Signature-256`                                            |
| `SLACK_WEBHOOK_URL`           | —                                                        | Slack integration; env wins over `/config`                                |

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

## 7. Verify your setup

```bash
curl -s localhost:3000/healthz                       # {"status":"ok",...}
curl -s localhost:3000/readyz                        # {"status":"ready"}
curl -s localhost:3000/api/v1/setup/status           # pending / applied / complete
curl -s localhost:3000/api/v1/system/manifest        # the modules you enabled
curl -s localhost:8000/ai/v1/health                  # ai-service (if running)
```

Then open the web app; the header shows exactly the enabled modules, and
`/config` shows the running setup.

## 8. Run the checks

```bash
pnpm lint && pnpm typecheck && pnpm test:ts && pnpm test:python && pnpm format:check
SKIP_DB_TESTS=1 pnpm test:ts                         # without Postgres
```

DB-backed suites use `DATABASE_URL` (default
`postgres://triageai:triageai@localhost:5432/triageai`). **Stop `pnpm dev`
first** — a running API shares the queue and steals workflow jobs from tests.
The setup suite creates and drops its own `triageai_setup_test` database.

## 9. Troubleshooting

| Symptom                                               | Fix                                                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Every route returns `409 setup.REQUIRED`              | Finish `/config`; if it says "applied", restart the API (compose does it automatically)                              |
| "That token was not accepted"                         | Copy it again from the API log; a restart issues a new one                                                           |
| "The secret store is off"                             | Make `$TRIAGEAI_SECRETS_DIR` writable (default `<data>/data/secrets`) or set `TRIAGEAI_SECRET_KEY` to 32+ characters |
| `AUTH_JWT_SECRET must be set` on boot                 | Auth is on but the secret store is off; set `AUTH_JWT_SECRET` or `TRIAGEAI_SECRET_KEY`                               |
| `/config` changes do not take effect                  | The API has not restarted; compose restarts on Apply, `pnpm dev` needs a manual restart                              |
| Stored secrets stopped working                        | `TRIAGEAI_SECRET_KEY`/`master.key` changed; restore the key file or re-enter the secrets                             |
| `Invalid environment configuration: DATABASE_URL`     | Copy `apps/api/.env.example` to `apps/api/.env`                                                                      |
| `kernel.BOOT_VALIDATION_FAILED … requires capability` | Your config/overlay enables a module whose capability isn't configured; re-run `/config`                             |
| `queue adapter "bullmq" is not implemented yet`       | Use `"pg-queue"` in `queue.adapter`                                                                                  |
| `core migration …: checksum` on boot                  | A migration was edited; migrations are immutable — reset the dev DB volume                                           |
| Chat always says "could not verify"                   | Add and **approve** documents in `/kb`; check `/runs` for the retrieval gate                                         |
| A model marked "too large" cannot be selected         | Tick "Allow models marked too large"; the estimate is advice, the runtime is the final judge                         |
| API in Docker can't reach Ollama on the host          | `TRIAGEAI_GENERATOR_BASE_URL=http://host.docker.internal:11434`                                                      |
| Port 3000/5432 already in use                         | Stop the other process, or change the left side of the compose port mapping                                          |
| Tests fail intermittently on workflow jobs            | Stop `pnpm dev`, or point tests at a dedicated database                                                              |

## 10. Operations

Backup/restore, upgrades and retention live in
[docs/OPERATIONS.md](./docs/OPERATIONS.md) (`scripts/backup.sh`,
`scripts/restore.sh`). Keep `TRIAGEAI_SECRET_KEY` with your deployment secrets,
never in a database dump; losing it means re-entering stored credentials.
