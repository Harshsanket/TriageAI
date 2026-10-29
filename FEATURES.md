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

| Capability     | Adapters                                                                        | Status |
| -------------- | ------------------------------------------------------------------------------- | :----: |
| Embedder       | ai-service (sentence-transformers, MiniLM default)                              |   ✅   |
| Classifier     | ai-service similarity baseline; trained linear probe via the model registry     |   ✅   |
| Vector store   | pgvector                                                                        |   ✅   |
| Retriever      | pgvector with per-collection threshold + margin sufficiency gate                |   ✅   |
| Generator      | Ollama, LM Studio, any OpenAI-compatible local server                           |   ✅   |
| Validator      | Format, grounding, citations, prompt-injection, PII, forbidden topics           |   ✅   |
| Model registry | Versioned assets, eval-gated promote, audited rollback, hot-swap without deploy |   ✅   |
| Model catalog  | Hugging Face search filtered by your hardware, one-click download               |   🗺️   |

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
| Customer can only see their own tickets                                    |   🟡   |
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

| Feature                                           | Status |
| ------------------------------------------------- | :----: |
| Conversations + messages                          |   ✅   |
| Grounded answers with citations, explicit refusal |   ✅   |
| Per-user conversation ownership                   |   🟡   |
| Streaming responses, memory/summary               |   🗺️   |

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

## 4. Improvement loop (host)

| Feature                                                              | Status |
| -------------------------------------------------------------------- | :----: |
| Corrections → candidate examples with provenance                     |   ✅   |
| Review queue (approve/reject, terminal, audited)                     |   ✅   |
| Deterministic, leakage-guarded dataset builder + export              |   ✅   |
| Linear-probe trainer (CPU), merged eval reports, gated promotion     |   ✅   |
| Eval harnesses: classification, retrieval, generation, merged report |   ✅   |

## 5. Operations & security

| Feature                                                                |            Status            |
| ---------------------------------------------------------------------- | :--------------------------: |
| Docker Compose profiles: core, ai, llm, queue, observ, train           |              ✅              |
| Loopback-only port binding by default (`TRIAGEAI_BIND`)                |              ✅              |
| Auth: argon2id, short JWT + rotating refresh tokens, replay revocation |              ✅              |
| RBAC matrix (public / customer / agent / admin, deny by default)       |              ✅              |
| Rate limiting, CORS allowlist, log/config secret redaction             |              ✅              |
| Ownership ACLs (customer sees only their own data)                     |              🟡              |
| Prometheus `/metrics`, Grafana, hardware monitor, k6 load suites       |              ✅              |
| Backup/restore scripts, retention scheduler                            |              ✅              |
| Multi-tenant enforcement, attachments                                  | 🗺️ (designed: ADR-0022/0023) |
| First-run setup wizard at `/config`                                    |              🗺️              |

## 6. Web UI routes

| Path                                          | Shown when                  |
| --------------------------------------------- | --------------------------- |
| `/support`                                    | `support` enabled           |
| `/chat`                                       | `chat` enabled              |
| `/kb`                                         | `kb` enabled                |
| `/doc-assistant`                              | `doc-assistant` enabled     |
| `/integrations/github`, `/integrations/slack` | integration enabled         |
| `/echo`                                       | `echo` enabled              |
| `/runs`, `/runs/:id`                          | always (inspector)          |
| `/feedback`                                   | always (review + registry)  |
| `/system`                                     | always (hardware + modules) |
| `/config`                                     | 🗺️ Phase 11 setup wizard    |
