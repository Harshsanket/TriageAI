# TriageAI — Features

What TriageAI does today (v1.1.0), grouped by layer, plus what is planned.
Status key: ✅ shipped · 🟡 partial / known gap · 🗺️ planned (see
[DEVELOPMENT_PLAN.md](./docs/DEVELOPMENT_PLAN.md)). Setup: [SETUP.md](./SETUP.md).

---

## 1. Platform kernel (`packages/kernel`)

| Feature                      | Status | Notes                                                                                                    |
| ---------------------------- | :----: | -------------------------------------------------------------------------------------------------------- |
| Module system                |   ✅   | Modules declare deps, capabilities, routes, migrations, stage handlers and a UI manifest                 |
| Config-driven enable/disable |   ✅   | JSON config + `/config` overlay; model temperature/tokens/timeout + retrieval tuning; danger-zone reset  |
| Dependency graph validation  |   ✅   | Cycles, missing modules, version ranges and missing capabilities fail boot with typed errors             |
| Immutable migrations         |   ✅   | Checksummed per module; edits are rejected; explicit admin uninstall drops module tables                 |
| Workflow engine              |   ✅   | Declarative stages with `when` guards, input refs, retry/backoff, timeouts, cancellation                 |
| Fallback policies            |   ✅   | `halt_run`, `return_uncertain`, `request_clarification`, `escalate_human`, `retry_alternative_retrieval` |
| Decision records             |   ✅   | Append-only evidence / deterministic / timings / error for every stage                                   |
| Durable queue                |   ✅   | Postgres `SKIP LOCKED` queue (default) + inline queue; at-least-once with idempotency keys               |
| Redis/BullMQ queue           |   🗺️   | Config name reserved; boot refuses it until the adapter exists                                           |
| Event bus                    |   ✅   | In-process; the only channel for cross-module data                                                       |
| Output channels              |   ✅   | Registry + shared HTTP shell (retries, rate limits, token rotation) + contract suite                     |
| Retention                    |   ✅   | Per-profile cutoffs; kernel deletes core rows, modules delete their own bodies                           |
| Runtime plugin install       |   ✅   | Signed `.tgz` packages, ed25519 + sha256 verification, hot enable/disable via kernel generation swap     |

### Phase 22 — module isolation

| Feature                       | Status | Notes                                                                                                 |
| ----------------------------- | :----: | ----------------------------------------------------------------------------------------------------- |
| Permission manifests + grants |   ✅   | default deny; routes/events/capabilities/stages/workflows/tools/egress/knowledge; denials audited     |
| Per-module storage            |   ✅   | `mod_<id>` schema + Postgres role; role-bound `ctx.database`; uninstall drops the schema              |
| Core read APIs                |   ✅   | `ctx.runs`, `ctx.audit`, `ctx.knowledge`, settings/cost/traces/feedback replace raw core-table SQL    |
| Capability providers          |   ✅   | `ctx.provideCapability` + config-selected router; built-in host adapters are providers                |
| MP1 protocol                  |   ✅   | strict envelope, broker/authorizer, replay + deadline checks, coreSig, TS SDK; serialized CI mode     |
| Supervisor                    |   ✅   | handshake, Stage-A tokens, health/drain/stop, timeouts, circuit breaker                               |
| Container modules             |   🟡   | `echo` MP1 server + `modules` compose profile; Slack/chat containers and Stage-B certificates pending |
| Packs                         |   🟡   | signed `pack.json` format + ticket-solver descriptor; install-as-a-unit UI pending                    |
| Edge adapters                 |   🟡   | MCP server + agent card; A2A task REST pending                                                        |

## 2. AI capabilities (swappable adapters)

| Capability               | Adapters                                                                                                           | Status |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | :----: |
| Embedder                 | ai-service (sentence-transformers, MiniLM default)                                                                 |   ✅   |
| Classifier               | ai-service similarity baseline; trained linear probe via the model registry                                        |   ✅   |
| Vector store             | pgvector                                                                                                           |   ✅   |
| Retriever                | pgvector with per-collection threshold + margin sufficiency gate                                                   |   ✅   |
| Generator                | Ollama, LM Studio, any OpenAI-compatible local server                                                              |   ✅   |
| Validator                | Format, grounding, citations, prompt-injection, PII, forbidden topics                                              |   ✅   |
| Model registry           | Versioned assets, eval-gated promote, audited rollback, hot-swap without deploy                                    |   ✅   |
| Model catalog            | Hugging Face search filtered by your hardware, one-click download                                                  |   ✅   |
| Hosted LLM APIs          | Anthropic, OpenAI, Google, any OpenAI-compatible host — opt-in, egress gate, redaction, daily budgets, cost ledger |   ✅   |
| ChatModel (tool calling) | One chat interface over every local and hosted adapter; tools land in Phase 15                                     |   ✅   |

## 3. Modules (feature plugins)

### Ticket solver — `support` + `ai-pipeline`

| Feature                                                                    | Status |
| -------------------------------------------------------------------------- | :----: |
| Ticket CRUD, messages, idempotent create                                   |   ✅   |
| Typed state machine (illegal transitions rejected)                         |   ✅   |
| Embedding classification with confidence thresholds                        |   ✅   |
| Versioned routing rules + policy table                                     |   ✅   |
| P0–P3 priority + team assignment, ambiguity → manual triage                |   ✅   |
| Agent queue, resolve, triage override → training candidates                |   ✅   |
| KB-grounded auto-reply with validation                                     |   ✅   |
| Per-category auto-reply policy (no deploy to flip)                         |   ✅   |
| Customer confirmation ("solved" / "still need help") + repeat-answer guard |   ✅   |
| Customer can only see their own tickets (internal notes/events hidden)     |   ✅   |
| Email in (signed webhook), outbox approval, threading                      |   ✅   |

### Knowledge base — `kb`

| Feature                                                                 | Status |
| ----------------------------------------------------------------------- | :----: |
| Document create / re-ingest / delete                                    |   ✅   |
| Deterministic chunking + embedding into pgvector                        |   ✅   |
| Enabled-source retrieval (no approval step; On means used)              |   ✅   |
| Storage totals (originals, text, chunks + vectors) per source           |   ✅   |
| Delete icon with confirmation; source, chunks, vectors and blob cleanup |   ✅   |
| Content-hash dedupe: the same file/note is ingested once                |   ✅   |
| File upload (PDF/DOCX/XLSX/CSV/MD/TXT/HTML), URL, GitHub repo, notes    |   ✅   |
| Per-source On/Off (pre-filter) + labels + source list/search            |   ✅   |
| Ingestion workflow with per-item progress and jobs tray                 |   ✅   |
| Source plugins (`KnowledgeSource`) with contract suite                  |   ✅   |
| OCR for scanned PDFs / folder import / plugin marketplace sources       |   🗺️   |

### Datasets — `data-extract`

| Feature                                                                   | Status |
| ------------------------------------------------------------------------- | :----: |
| CSV/XLSX/PDF text → typed `transactions` or `generic-table` dataset       |   ✅   |
| Deterministic mapping + saved confirmations; user rules                   |   ✅   |
| Balance reconciliation gate; `needs_review` never reaches charts          |   ✅   |
| Dataset views (totals, categories, months, merchants, rows) + pin         |   ✅   |
| `data_extract.query_dataset` fixed-schema SQL tool; restricted by default |   ✅   |
| Invoice/contacts profiles and schema-bound model proposals                |   🗺️   |

### Chatbot — `chat`

| Feature                                                                                                                     | Status |
| --------------------------------------------------------------------------------------------------------------------------- | :----: |
| Conversations + messages                                                                                                    |   ✅   |
| Grounded answers with citations; `prefer`/`only` knowledge modes, labelled general answers, small-talk gate                 |   ✅   |
| Replies show the chat agent's display name and colour (never "Assistant")                                                   |   ✅   |
| Per-user conversation ownership                                                                                             |   ✅   |
| Conversation history: sidebar, search, rename, pin, delete/restore, export; replies use earlier turns                       |   🗺️   |
| Streaming responses, memory/summary                                                                                         |   🗺️   |
| Chat-only mode: answers without a KB; bootstraps a conversation-scoped seed from the first prompt                           |   🗺️   |
| Homepage conversation shell: one chat at `/`, `/?c=<id>` reopens after reload, per-user history-sidebar toggle, ocean pause |   ✅   |

### Doc assistant — `doc-assistant`

Answers questions about this repository's `docs/**` with file-path citations and
refuses when something isn't documented; injection-resistant. ✅

### Integrations — `integrations-github`, `integrations-slack`

| Feature                                                         | Status |
| --------------------------------------------------------------- | :----: |
| GitHub: one issue per ticket (marker dedupe), labels, link-back |   ✅   |
| GitHub: signed webhooks, issue ↔ ticket status sync             |   ✅   |
| Slack: critical-immediate vs batched digests, dedupe window     |   ✅   |
| Per-category approval gate, approve/reject/retry, audit rows    |   ✅   |

### Echo — `echo`

Reference module for authors: a minimal workflow, route, migration and UI. ✅

### Planned interface plugins

| Plugin       | What it does                                                                                               | Status |
| ------------ | ---------------------------------------------------------------------------------------------------------- | :----: |
| `public-api` | Hashed scoped keys + OpenAI-compatible `/v1/chat/completions` + `/v1/embeddings` + KB search (MCP pending) |   ✅   |
| `emailer`    | Signed inbound webhook → tickets, threaded replies, approval-gated SMTP outbox (IMAP polling pending)      |   ✅   |

## 4. Agents, tools and skills (partial, Phases 15–17)

| Feature                                                                                                                                                         | Status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----: |
| Tool registry with a mandatory contract, read/write + low/high labels, rule floor, undo class and preview check                                                 |   ✅   |
| Approval policy per agent: ask a human, or auto with an allowlist of functions (conditions + daily limits); deletes, payments and permission changes always ask |   🗺️   |
| MCP client: connect external MCP servers as tools                                                                                                               |   🗺️   |
| Connectors for external apps (CRM, calendar, databases, docs, ticketing) via OpenAPI/GraphQL/SQL/MCP or first-party plugins, with OAuth, sync and triggers      |   🗺️   |
| Skills in Agent Skills format: frontmatter index, lazy body load, path-traversal guards (git pinning/packs pending)                                             |   ✅   |
| Import Claude Code / Cursor plugin packs (e.g. [pstack](https://github.com/cursor/plugins/tree/main/pstack)) as skills + agent profiles                         |   🗺️   |
| Agents with per-step checkpointed state that resume after a crash                                                                                               |   🗺️   |
| Need-based context: each step gets only what it needs (short- or long-term), fetched on demand; ceilings, never filling the window; waste measured              |   🗺️   |
| Capped, structured handoffs between agents (DTO + trim validator; not yet wired to an agent loop)                                                               |   🟡   |
| Shared state (CAS), proof-gated work board, workspace decisions and one pure context packer                                                                     |   🟡   |
| Per-run local workspace (handoff, log, decisions, plans) mirrored from the DB                                                                                   |   🗺️   |
| Long-term memory: sourced ≤300-char entries, volatile-field rejection, dedupe, lessons proposed (lexical retrieval)                                             |   🟡   |
| Teams with any model mix: api + local, api + api, local + local                                                                                                 |   🗺️   |
| `/agents` monitor, watchdog agent, external agents reporting via the public API                                                                                 |   🗺️   |
| Agent setup from [docs-internal](https://github.com/Harshsanket/docs-internal) conventions                                                                      |   🗺️   |

### Running agents safely (planned, Phase 18)

| Feature                                                                                                                                                                                                                                          | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----: |
| Continuous self-evaluation: sampled online scoring, nightly regression evals, drift alerts                                                                                                                                                       |   🗺️   |
| Trace-level evaluation: every important step in a run (decisions, retrieval, tool calls, handoffs) is scored, not only the final answer; first bad step shown on the run                                                                         |   🗺️   |
| Scenario test suites (happy, ambiguous, out-of-scope, tool failure, malicious, invalid input, partial info, policy edge) rerun on every model or prompt change                                                                                   |   🗺️   |
| Every model call wrapped like an unreliable dependency: limits, timeouts, structured output with repair, retries, fallbacks, quality checks                                                                                                      |   🗺️   |
| Scope and intent gate stops out-of-scope requests before they cost tokens or tool calls                                                                                                                                                          |   🗺️   |
| Trusted instructions kept separate from untrusted content; nothing executed from model text; safe rendering of model output                                                                                                                      |   🗺️   |
| Full trace for every model call: model, version, prompt id, step, workflow, conversation, tools, latency, time to first token, tokens, cost, retries, fallback, errors, feedback, eval scores                                                    |   🗺️   |
| Privacy: minimum data per task, PII masked at write, before send, in the UI and exports; retention for logs, traces and archives                                                                                                                 |   🗺️   |
| Dashboard metrics: tokens/s, usage, context use, cache use, latency, workload, intent accuracy, tool success, valid-schema rate, retrieval hit rate, refusal accuracy, completion rate, time on task, user flags, cost per token/step/conversion |   🗺️   |
| Streaming answers and friendly progress states ("Cooking the answer…") with a neutral mode                                                                                                                                                       |   🗺️   |
| Greeting with app name, time of day and your name; name and rename agents                                                                                                                                                                        |   🗺️   |
| Retrieval quality: structure-aware chunking, metadata filters, hybrid search, re-ranking, freshness, full source attribution                                                                                                                     |   🗺️   |
| Improvements proposed as diffs, applied only after eval gate + approval (no silent self-modification)                                                                                                                                            |   🗺️   |
| Opt-in auto-rollback of a version that falls below its quality floor                                                                                                                                                                             |   🗺️   |
| One resumable state model for workflows, agents and teams, with pinned versions per run                                                                                                                                                          |   🗺️   |
| Explicit control flow: every workflow, agent loop and team is a declared, validated graph; models only choose between declared paths; the taken path is drawn on each run                                                                        |   🗺️   |
| Simplest execution style first: known steps run as pipelines or state machines; agents only for work that needs dynamic decisions; planning/reflection only when useful                                                                          |   🗺️   |
| Concurrency limits, priority lanes, backpressure, durable scheduler and event outbox                                                                                                                                                             |   🗺️   |
| Traces across model, tool and agent calls; token/cost/eval metrics; alerting                                                                                                                                                                     |   🗺️   |
| Kill switches (pause agents, disable hosted models, read-only, freeze plugins), egress allowlist, tamper-evident audit                                                                                                                           |   🗺️   |
| Every setting on `/config` with a one-line explanation, versioned and revertible                                                                                                                                                                 |   🗺️   |
| Storage by access pattern: Postgres by default (partitioned logs, JSONB, full-text, pgvector with HNSW), Redis/S3/Qdrant only past measured thresholds                                                                                           |   🗺️   |
| Data policy: every kind of data has rules; per-class overrides within bounds, named policies, reset, versioned + audited                                                                                                                         |   ✅   |

| Cost-aware model routing: cheapest model that meets each task's measured quality floor | 🗺️ |
| Cost ledger per call, budgets, forecasts; caching, batching and coordination-overhead tracking | 🗺️ |
| `/dashboard`: health, activity, knowledge, cost, efficiency, model usage (tokens/TTFT/speed), uptime, storage, machine, agents, dead letters, connected APIs, security on one page; refresh interval configurable (default 10 min) | ✅ |
| "Ask the system": plain-language questions about past activity ("what was done on this day?") answered by a small local model with links | 🗺️ |

## 5. Improvement loop (host)

| Feature                                                                         | Status |
| ------------------------------------------------------------------------------- | :----: |
| Corrections → candidate examples with provenance                                |   ✅   |
| Review queue (approve/reject, terminal, audited)                                |   ✅   |
| Deterministic, leakage-guarded dataset builder + export                         |   ✅   |
| Linear-probe trainer (CPU), merged eval reports, gated promotion                |   ✅   |
| Eval harnesses: classification, retrieval, generation, merged report            |   ✅   |
| Feedback insights: source, detail, processing timeline, filters and four graphs |   ✅   |

## 6. Operations & security

| Feature                                                                                                                                               |            Status            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------: |
| Docker Compose profiles: core, ai, llm, queue, observ, train                                                                                          |              ✅              |
| Loopback-only port binding by default (`TRIAGEAI_BIND`)                                                                                               |              ✅              |
| Auth: argon2id, short JWT + rotating refresh tokens, replay revocation                                                                                |              ✅              |
| RBAC matrix (public / customer / agent / admin, deny by default)                                                                                      |              ✅              |
| Rate limiting, CORS allowlist, log/config secret redaction                                                                                            |              ✅              |
| Ownership ACLs (customer sees only their own data)                                                                                                    |              ✅              |
| Typed errors with one envelope everywhere, retry only what can succeed, circuit breakers, dead-letter replay, graceful degradation                    |        🟡 (10C.T1–T5)        |
| Prometheus `/metrics` (admin or `METRICS_TOKEN`), Grafana, hardware monitor, k6 load suites                                                           |              ✅              |
| Backup/restore scripts, retention scheduler                                                                                                           |              ✅              |
| Multi-tenant enforcement, attachments                                                                                                                 | 🗺️ (designed: ADR-0022/0023) |
| First-run setup wizard at `/config`                                                                                                                   |              ✅              |
| Config overlay: versioned, audited DB answers above the file, below env; encrypted secret store (key file by default); restart-to-apply               |              ✅              |
| Connected APIs: list/add/test/rotate/disable/remove external APIs with secret status                                                                  |              ✅              |
| Admin dashboard: health, activity, knowledge, security, tokens/performance, uptime, storage, machine, dead letters and connected APIs; manifest-gated |              ✅              |
| Committed `WORKFLOW.md` project map + `pnpm docs:workflow` with a CI drift/line-budget check                                                          |              ✅              |
| Appearance: Light/Dark/Auto theme, four font sizes, animations On/Off/Auto, per-user agent names/colours, admin defaults                              |              ✅              |
| Notification tray for long jobs (progress, ETA, cancel; survives reload)                                                                              |              ✅              |
| Dashboard graphs: model token usage (Day/Month/Year/custom; model/agent/module), agents, knowledge growth, pinned datasets                            |              ✅              |
| Setup lifecycle: exact scoping, add/remove interfaces, Reset vs Reset and erase                                                                       |              ✅              |

## 7. Web UI routes

| Path                                          | Shown when                                                       |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `/support`                                    | `support` enabled                                                |
| `/`                                           | `chat` enabled (chat lives here); `/chat[/:id]` redirects        |
| `/kb`                                         | `kb` enabled                                                     |
| `/doc-assistant`                              | `doc-assistant` enabled                                          |
| `/integrations/github`, `/integrations/slack` | integration enabled                                              |
| `/echo`                                       | `echo` enabled                                                   |
| `/data-extract`                               | `data-extract` enabled                                           |
| `/dashboard`                                  | always (admin; health/activity/knowledge/security/usage/storage) |
| `/runs`, `/runs/:id`                          | always (inspector)                                               |
| `/feedback`                                   | always (feedback insights + review)                              |
| `/config`                                     | always (setup wizard while pending, then settings)               |

## 8. Base memory, runtime control, context and skills (Phases 24–27)

| Feature                           | Status | Notes                                                                                                                                 |
| --------------------------------- | :----: | ------------------------------------------------------------------------------------------------------------------------------------- |
| Base memory from setup            |   ✅   | Managed `base-memory.public` / `base-memory.operator` KB sources generated from setup, refreshed on config changes and manual request |
| Audience-aware retrieval          |   ✅   | Customer chat/support/public API retrieve public only; operator and doc surfaces see both                                             |
| Operational memory + status tools |   ✅   | Managed operator `system-status` snapshot plus read-only `system.get_status/get_uptime/get_storage` tools                             |
| Runtime inventory + LLM switches  |   ✅   | Global `llmDisabled` and per-runtime switches enforced before network/cache; Models and dashboard surfaces                            |
| Multi-runtime selection           |   🟡   | Configured runtime pool selects the first enabled runtime; quality/egress/cost scoring is not yet measured                            |
| Chat context budget + compaction  |   ✅   | Per-call budget from the active window, shared packer, 80–85 % high-water compaction, durable summary, deterministic fallback         |
| Context usage ring                |   ✅   | Composer ring shows used/total tokens, warning near the high-water mark, "not measured" before the first call                         |
| User skills                       |   ✅   | Owner-scoped store, On/Off, GitHub import with pin/ETag, custom creation, suggestions from chat                                       |
| Skills surfaces                   |   ✅   | Home drawer below the sidebar toggle and `/config` → Skills share one registry                                                        |
| Skill KB mirror                   |   ✅   | Enabled skills become managed read-only operator `skill:` sources and are removed on disable/delete                                   |
| Default skill sources             |   🟡   | Listed with import state; automatic boot fetch is not enabled                                                                         |
