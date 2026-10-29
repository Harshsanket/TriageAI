# TriageAI — Features

What TriageAI does today (v1.0.0), grouped by layer, plus what is planned.
Status key: ✅ shipped · 🟡 partial / known gap · 🗺️ planned (see
[DEVELOPMENT_PLAN.md](./docs/DEVELOPMENT_PLAN.md)). Setup: [SETUP.md](./SETUP.md).

---

## 1. Platform kernel (`packages/kernel`)

| Feature                      | Status | Notes                                                                                                    |
| ---------------------------- | :----: | -------------------------------------------------------------------------------------------------------- |
| Module system                |   ✅   | Modules declare deps, capabilities, routes, migrations, stage handlers and a UI manifest                 |
| Config-driven enable/disable |   ✅   | JSON config + `TRIAGEAI_ENABLE/DISABLE_MODULES`; restart-time; validated at boot                         |
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
| Runtime plugin install       |   🗺️   | Phase 12 — download, verify and hot-load modules without rebuilding images                               |

## 2. AI capabilities (swappable adapters)

| Capability               | Adapters                                                                                                  | Status |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | :----: |
| Embedder                 | ai-service (sentence-transformers, MiniLM default)                                                        |   ✅   |
| Classifier               | ai-service similarity baseline; trained linear probe via the model registry                               |   ✅   |
| Vector store             | pgvector                                                                                                  |   ✅   |
| Retriever                | pgvector with per-collection threshold + margin sufficiency gate                                          |   ✅   |
| Generator                | Ollama, LM Studio, any OpenAI-compatible local server                                                     |   ✅   |
| Validator                | Format, grounding, citations, prompt-injection, PII, forbidden topics                                     |   ✅   |
| Model registry           | Versioned assets, eval-gated promote, audited rollback, hot-swap without deploy                           |   ✅   |
| Model catalog            | Hugging Face search filtered by your hardware, one-click download                                         |   ✅   |
| Hosted LLM APIs          | Anthropic, OpenAI, Google, any OpenAI-compatible host — opt-in with egress classes, redaction and budgets |   🗺️   |
| ChatModel (tool calling) | One chat + tools interface over every local and hosted adapter                                            |   🗺️   |

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
| Email in/out for tickets                                                   |   🗺️   |

### Knowledge base — `kb`

| Feature                                              | Status |
| ---------------------------------------------------- | :----: |
| Document create / approve / re-ingest / delete       |   ✅   |
| Deterministic chunking + embedding into pgvector     |   ✅   |
| Approved-only retrieval (enforced in every query)    |   ✅   |
| File upload (PDF, DOCX, HTML), URL and folder import |   🗺️   |
| Document version history, stale-vector cleanup       |   🟡   |

### Chatbot — `chat`

| Feature                                                                                               | Status |
| ----------------------------------------------------------------------------------------------------- | :----: |
| Conversations + messages                                                                              |   ✅   |
| Grounded answers with citations, explicit refusal                                                     |   ✅   |
| Per-user conversation ownership                                                                       |   ✅   |
| Conversation history: sidebar, search, rename, pin, delete/restore, export; replies use earlier turns |   🗺️   |
| Streaming responses, memory/summary                                                                   |   🗺️   |

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

| Plugin       | What it does                                                                                                    | Status |
| ------------ | --------------------------------------------------------------------------------------------------------------- | :----: |
| `public-api` | API keys + OpenAI-compatible `/v1/chat/completions` and a REST/MCP surface so other agent apps can use TriageAI |   🗺️   |
| `emailer`    | IMAP/SMTP (or provider webhook) inbound mail → tickets, validated replies out                                   |   🗺️   |

## 4. Agents, tools and skills (planned, Phases 15–17)

| Feature                                                                                                                                                         | Status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----: |
| Tool registry with read/write and low/high-risk labels; high-risk calls need preview, intent and taint checks                                                   |   🗺️   |
| Approval policy per agent: ask a human, or auto with an allowlist of functions (conditions + daily limits); deletes, payments and permission changes always ask |   🗺️   |
| MCP client: connect external MCP servers as tools                                                                                                               |   🗺️   |
| Connectors for external apps (CRM, calendar, databases, docs, ticketing) via OpenAPI/GraphQL/SQL/MCP or first-party plugins, with OAuth, sync and triggers      |   🗺️   |
| Skills in Agent Skills format, sha-pinned sources, loaded on demand — starting with [mattpocock/skills](https://github.com/mattpocock/skills)                   |   🗺️   |
| Import Claude Code / Cursor plugin packs (e.g. [pstack](https://github.com/cursor/plugins/tree/main/pstack)) as skills + agent profiles                         |   🗺️   |
| Agents with per-step checkpointed state that resume after a crash                                                                                               |   🗺️   |
| Need-based context: each step gets only what it needs (short- or long-term), fetched on demand; ceilings, never filling the window; waste measured              |   🗺️   |
| Capped, structured handoffs between agents (no transcript dumps)                                                                                                |   🗺️   |
| Shared state, task board and decisions log across all agents in a workspace; one context-building rule                                                          |   🗺️   |
| Per-run local workspace (handoff, log, decisions, plans) mirrored from the DB                                                                                   |   🗺️   |
| Long-term memory across runs: short sourced entries, deduped, capped, reviewable, user-erasable                                                                 |   🗺️   |
| Teams with any model mix: api + local, api + api, local + local                                                                                                 |   🗺️   |
| `/agents` monitor, watchdog agent, external agents reporting via the public API                                                                                 |   🗺️   |
| Agent setup from [docs-internal](https://github.com/Harshsanket/docs-internal) conventions                                                                      |   🗺️   |

### Running agents safely (planned, Phase 18)

| Feature                                                                                                                                                                   | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----: |
| Continuous self-evaluation: sampled online scoring, nightly regression evals, drift alerts                                                                                |   🗺️   |
| Trace-level evaluation: every important step in a run (decisions, retrieval, tool calls, handoffs) is scored, not only the final answer; first bad step shown on the run  |   🗺️   |
| Improvements proposed as diffs, applied only after eval gate + approval (no silent self-modification)                                                                     |   🗺️   |
| Opt-in auto-rollback of a version that falls below its quality floor                                                                                                      |   🗺️   |
| One resumable state model for workflows, agents and teams, with pinned versions per run                                                                                   |   🗺️   |
| Explicit control flow: every workflow, agent loop and team is a declared, validated graph; models only choose between declared paths; the taken path is drawn on each run |   🗺️   |
| Simplest execution style first: known steps run as pipelines or state machines; agents only for work that needs dynamic decisions; planning/reflection only when useful   |   🗺️   |
| Concurrency limits, priority lanes, backpressure, durable scheduler and event outbox                                                                                      |   🗺️   |
| Traces across model, tool and agent calls; token/cost/eval metrics; alerting                                                                                              |   🗺️   |
| Kill switches (pause agents, disable hosted models, read-only, freeze plugins), egress allowlist, tamper-evident audit                                                    |   🗺️   |
| Every setting on `/config` with a one-line explanation, versioned and revertible                                                                                          |   🗺️   |
| Storage by access pattern: Postgres by default (partitioned logs, JSONB, full-text, pgvector with HNSW), Redis/S3/Qdrant only past measured thresholds                    |   🗺️   |
| Data policy: every kind of data has rules for where it's stored, how long it's kept, how it's retrieved, and whether a model may see it (sent, redacted or withheld)      |   🗺️   |
| `WORKFLOW.md`: short committed project map (design, contracts, routing, observability, model strategy, cost) kept in sync by CI                                           |   🗺️   |
| Cost-aware model routing: cheapest model that meets each task's measured quality floor                                                                                    |   🗺️   |
| Cost ledger per call, budgets, forecasts; caching, batching and coordination-overhead tracking                                                                            |   🗺️   |
| `/dashboard`: health, activity, quality, cost, efficiency, context, agents, security on one page                                                                          |   🗺️   |
| "Ask the system": plain-language questions about past activity ("what was done on this day?") answered by a small local model with links                                  |   🗺️   |

## 5. Improvement loop (host)

| Feature                                                              | Status |
| -------------------------------------------------------------------- | :----: |
| Corrections → candidate examples with provenance                     |   ✅   |
| Review queue (approve/reject, terminal, audited)                     |   ✅   |
| Deterministic, leakage-guarded dataset builder + export              |   ✅   |
| Linear-probe trainer (CPU), merged eval reports, gated promotion     |   ✅   |
| Eval harnesses: classification, retrieval, generation, merged report |   ✅   |

## 6. Operations & security

| Feature                                                                                                                            |            Status            |
| ---------------------------------------------------------------------------------------------------------------------------------- | :--------------------------: |
| Docker Compose profiles: core, ai, llm, queue, observ, train                                                                       |              ✅              |
| Loopback-only port binding by default (`TRIAGEAI_BIND`)                                                                            |              ✅              |
| Auth: argon2id, short JWT + rotating refresh tokens, replay revocation                                                             |              ✅              |
| RBAC matrix (public / customer / agent / admin, deny by default)                                                                   |              ✅              |
| Rate limiting, CORS allowlist, log/config secret redaction                                                                         |              ✅              |
| Ownership ACLs (customer sees only their own data)                                                                                 |              ✅              |
| Typed errors with one envelope everywhere, retry only what can succeed, circuit breakers, dead-letter replay, graceful degradation |              🗺️              |
| Prometheus `/metrics` (admin or `METRICS_TOKEN`), Grafana, hardware monitor, k6 load suites                                        |              ✅              |
| Backup/restore scripts, retention scheduler                                                                                        |              ✅              |
| Multi-tenant enforcement, attachments                                                                                              | 🗺️ (designed: ADR-0022/0023) |
| First-run setup wizard at `/config`                                                                                                |              ✅              |
| Config overlay: versioned, audited DB answers above the file, below env; encrypted secret store; restart-to-apply                  |              ✅              |

## 7. Web UI routes

| Path                                          | Shown when                                         |
| --------------------------------------------- | -------------------------------------------------- |
| `/support`                                    | `support` enabled                                  |
| `/chat`                                       | `chat` enabled                                     |
| `/kb`                                         | `kb` enabled                                       |
| `/doc-assistant`                              | `doc-assistant` enabled                            |
| `/integrations/github`, `/integrations/slack` | integration enabled                                |
| `/echo`                                       | `echo` enabled                                     |
| `/runs`, `/runs/:id`                          | always (inspector)                                 |
| `/feedback`                                   | always (review + registry)                         |
| `/system`                                     | always (hardware + modules)                        |
| `/config`                                     | always (setup wizard while pending, then settings) |
