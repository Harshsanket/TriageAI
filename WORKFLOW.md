# TriageAI — Workflow

The owner's project map: work in, graphs, results out, where to look when it
breaks, and what each model call may cost. Tables that can drift sit between
`<!-- generated:<name> -->` markers and come from the code via
`pnpm docs:workflow`; CI fails on drift, a missing section or >400 lines.
## 1. System design
TriageAI is a modular monolith: the kernel owns boot, config, the module graph,
migrations, the workflow engine, queue, events and decision records. Feature code
lives in `modules/*` and touches the outside world only through `KernelContext`.

```
Browser (apps/web) ── /api ──► Fastify host (apps/api)
                                ├─ kernel: config · module graph · migrations
                                │          workflow engine · queue · events · decisions
                                ├─ modules: support · kb · chat · ai-pipeline
                                │           doc-assistant · integrations-* · echo
                                ├─ capabilities: embedder · classifier · vectorStore
                                │   retriever · generator · validator · modelRegistry
                                │   outputChannel
                                └─ stores: Postgres + pgvector (default queue/data)
                                    ai-service (Python) · Ollama/LM Studio/hosted
```

| Profile | Services | Use |
| --- | --- | --- |
| `core` | postgres, api, web | default install; echo profile |
| `ai` / `llm` | + ai-service / ollama | embeddings+classification / generation |
| `queue` / `observ` / `train` | + redis / prometheus+grafana / trainer | queue, dashboards, training |

Setup gates everything until `/config` applies an overlay (ADR-0024); plugin
installs hot-load a generation and uninstall is explicit.
## 2. Input contract
| Entry | Transport | Auth | Notes |
| --- | --- | --- | --- |
| Web UI | `apps/web` → `/api/v1/*` | bearer or disabled mode | home is the chat (`/?c=<id>`); `/chat` redirects; renders only manifest modules (ADR-0007) |
| Module + host REST | `ctx.registerRoute` / `apps/api/src/routes` | RBAC, deny by default | modules never see Fastify |
| Webhooks | `POST /api/v1/integrations/:provider/webhook` | HMAC, public | GitHub/Slack |
| Setup | `/api/v1/setup/*` | setup token | dies at `complete` |
| Queue jobs/schedules | `queue_jobs` (`SKIP LOCKED`) | internal | at-least-once |
| Public API / MCP / email / handoffs | `/v1/*`, `/api/v1/mcp`, `/api/v1/emailer/*` | scoped keys, approval / HMAC | Phase 13 + 27 |

Rate limit 300/min (login 10/min); CORS is an allowlist. `AUTH_MODE=required`
is deny-by-default; `disabled` makes every caller admin, so bind to loopback.
<!-- generated:routes -->

| Method | Path | Roles |
| --- | --- | --- |
| GET | `/api/v1/approvals` | agent, admin |
| POST | `/api/v1/approvals/:id/approve` | admin |
| POST | `/api/v1/approvals/:id/reject` | admin |
| POST | `/api/v1/auth/login` | public |
| POST | `/api/v1/auth/logout` | public |
| GET | `/api/v1/auth/me` | customer, agent, admin |
| POST | `/api/v1/auth/refresh` | public |
| POST | `/api/v1/auth/register` | public |
| GET | `/api/v1/auth/users` | admin |
| POST | `/api/v1/auth/users` | admin |
| PATCH | `/api/v1/auth/users/:id/role` | admin |
| GET | `/api/v1/chat/conversations` | customer, agent, admin |
| POST | `/api/v1/chat/conversations` | customer, agent, admin |
| DELETE | `/api/v1/chat/conversations/:id` | customer, agent, admin |
| GET | `/api/v1/chat/conversations/:id` | customer, agent, admin |
| PATCH | `/api/v1/chat/conversations/:id` | customer, agent, admin |
| GET | `/api/v1/chat/conversations/:id/export` | customer, agent, admin |
| POST | `/api/v1/chat/conversations/:id/restore` | customer, agent, admin |
| POST | `/api/v1/chat/messages` | customer, agent, admin |
| POST | `/api/v1/chat/stream` | customer, agent, admin |
| GET | `/api/v1/connections` | admin |
| POST | `/api/v1/connections` | admin |
| DELETE | `/api/v1/connections/:id` | admin |
| POST | `/api/v1/connections/:id/disable` | admin |
| PUT | `/api/v1/connections/:id/secret` | admin |
| POST | `/api/v1/connections/:id/test` | admin |
| GET | `/api/v1/data-extract/datasets` | agent, admin |
| POST | `/api/v1/data-extract/datasets` | admin |
| DELETE | `/api/v1/data-extract/datasets/:id` | admin |
| GET | `/api/v1/data-extract/datasets/:id` | agent, admin |
| PATCH | `/api/v1/data-extract/datasets/:id` | agent, admin |
| POST | `/api/v1/data-extract/datasets/:id/confirm` | admin |
| GET | `/api/v1/data-extract/datasets/:id/rows` | agent, admin |
| GET | `/api/v1/data-extract/datasets/:id/summary` | agent, admin |
| POST | `/api/v1/data-extract/rules` | admin |
| GET | `/api/v1/datasets` | agent, admin |
| POST | `/api/v1/datasets` | admin |
| GET | `/api/v1/datasets/:id` | agent, admin |
| GET | `/api/v1/datasets/:id/export` | agent, admin |
| POST | `/api/v1/doc-assistant/ask` | customer, agent, admin |
| POST | `/api/v1/doc-assistant/reingest` | admin |
| POST | `/api/v1/echo/note` | customer, agent, admin |
| POST | `/api/v1/echo/run` | customer, agent, admin |
| GET | `/api/v1/echo/runs` | customer, agent, admin |
| POST | `/api/v1/emailer/inbound` | public |
| GET | `/api/v1/emailer/outbox` | agent, admin |
| POST | `/api/v1/emailer/outbox/:id/approve` | admin |
| POST | `/api/v1/emailer/send` | agent, admin |
| GET | `/api/v1/emailer/threads` | agent, admin |
| GET | `/api/v1/integrations/:provider/actions` | agent, admin |
| POST | `/api/v1/integrations/:provider/actions/:id/approve` | admin |
| POST | `/api/v1/integrations/:provider/actions/:id/reject` | admin |
| POST | `/api/v1/integrations/:provider/actions/:id/retry` | admin |
| POST | `/api/v1/integrations/:provider/webhook` | public |
| GET | `/api/v1/kb/documents` | agent, admin |
| POST | `/api/v1/kb/documents` | admin |
| DELETE | `/api/v1/kb/documents/:id` | admin |
| GET | `/api/v1/kb/documents/:id` | agent, admin |
| POST | `/api/v1/kb/documents/:id/approve` | admin |
| POST | `/api/v1/kb/documents/:id/reingest` | admin |
| POST | `/api/v1/kb/managed` | admin |
| POST | `/api/v1/kb/search` | agent, admin |
| GET | `/api/v1/kb/sources` | agent, admin |
| POST | `/api/v1/kb/sources` | admin |
| DELETE | `/api/v1/kb/sources/:id` | admin |
| PATCH | `/api/v1/kb/sources/:id` | admin |
| POST | `/api/v1/kb/sources/:id/approve` | admin |
| POST | `/api/v1/kb/sources/batch` | admin |
| GET | `/api/v1/kb/storage` | agent, admin |
| POST | `/api/v1/mcp` | admin |
| GET | `/api/v1/mcp/card` | admin |
| GET | `/api/v1/me/preferences` | customer, agent, admin |
| PUT | `/api/v1/me/preferences` | customer, agent, admin |
| GET | `/api/v1/models` | agent, admin |
| POST | `/api/v1/models` | admin |
| POST | `/api/v1/models/:id/promote` | admin |
| POST | `/api/v1/models/:id/rollback` | admin |
| GET | `/api/v1/models/eval-reports` | agent, admin |
| POST | `/api/v1/models/eval-reports` | admin |
| GET | `/api/v1/plugins` | admin |
| DELETE | `/api/v1/plugins/:id` | admin |
| POST | `/api/v1/plugins/:id/disable` | admin |
| POST | `/api/v1/plugins/:id/enable` | admin |
| GET | `/api/v1/plugins/available` | admin |
| POST | `/api/v1/plugins/install` | admin |
| GET | `/api/v1/plugins/latest/:id` | admin |
| GET | `/api/v1/public-api/external-agents` | admin |
| POST | `/api/v1/public-api/external-agents` | admin |
| POST | `/api/v1/public-api/external-agents/:id/handoffs` | admin |
| POST | `/api/v1/public-api/kb/search` | key |
| GET | `/api/v1/public-api/keys` | admin |
| POST | `/api/v1/public-api/keys` | admin |
| POST | `/api/v1/public-api/keys/:id/revoke` | admin |
| POST | `/api/v1/setup/add` | admin |
| GET | `/api/v1/setup/agent-defaults` | admin |
| PUT | `/api/v1/setup/appearance-defaults` | admin |
| POST | `/api/v1/setup/apply` | admin |
| GET | `/api/v1/setup/config/effective` | admin |
| GET | `/api/v1/setup/draft` | admin |
| PUT | `/api/v1/setup/draft` | admin |
| POST | `/api/v1/setup/erase` | admin |
| GET | `/api/v1/setup/hardware` | admin |
| POST | `/api/v1/setup/imports/retry` | admin |
| POST | `/api/v1/setup/llm/test` | admin |
| GET | `/api/v1/setup/model-settings` | admin |
| PUT | `/api/v1/setup/model-settings` | admin |
| GET | `/api/v1/setup/models` | admin |
| POST | `/api/v1/setup/models/pull` | admin |
| POST | `/api/v1/setup/plan` | admin |
| POST | `/api/v1/setup/remove` | admin |
| POST | `/api/v1/setup/reset` | admin |
| POST | `/api/v1/setup/restart` | admin |
| GET | `/api/v1/setup/secrets` | admin |
| PUT | `/api/v1/setup/secrets/:name` | admin |
| GET | `/api/v1/setup/status` | public |
| GET | `/api/v1/skills` | customer, agent, admin |
| POST | `/api/v1/skills` | customer, agent, admin |
| DELETE | `/api/v1/skills/:id` | customer, agent, admin |
| PATCH | `/api/v1/skills/:id` | customer, agent, admin |
| POST | `/api/v1/skills/:id/suggestion` | customer, agent, admin |
| GET | `/api/v1/skills/:name` | customer, agent, admin |
| GET | `/api/v1/skills/export` | customer, agent, admin |
| POST | `/api/v1/skills/import` | admin |
| GET | `/api/v1/skills/sources` | admin |
| GET | `/api/v1/support/auto-reply-policies` | agent, admin |
| PUT | `/api/v1/support/auto-reply-policies/:category` | admin |
| GET | `/api/v1/support/canned-responses` | agent, admin |
| POST | `/api/v1/support/canned-responses` | admin |
| GET | `/api/v1/support/my-tickets` | customer, agent, admin |
| GET | `/api/v1/support/queue` | agent, admin |
| GET | `/api/v1/support/sla/breaches` | agent, admin |
| GET | `/api/v1/support/tickets` | agent, admin |
| POST | `/api/v1/support/tickets` | customer, agent, admin |
| GET | `/api/v1/support/tickets/:id` | customer, agent, admin |
| PATCH | `/api/v1/support/tickets/:id/assignment` | agent, admin |
| POST | `/api/v1/support/tickets/:id/auto-reply` | agent, admin |
| POST | `/api/v1/support/tickets/:id/confirmation` | customer, agent, admin |
| POST | `/api/v1/support/tickets/:id/csat` | customer, agent, admin |
| POST | `/api/v1/support/tickets/:id/resolve` | agent, admin |
| POST | `/api/v1/support/tickets/:id/transitions` | agent, admin |
| PATCH | `/api/v1/support/tickets/:id/triage` | agent, admin |
| GET | `/api/v1/support/triage-policy` | agent, admin |
| GET | `/api/v1/system/alerts` | admin |
| GET | `/api/v1/system/audit` | admin |
| GET | `/api/v1/system/audit/verify` | admin |
| POST | `/api/v1/system/base-memory/refresh` | admin |
| GET | `/api/v1/system/candidates` | agent, admin |
| POST | `/api/v1/system/candidates` | agent, admin |
| PATCH | `/api/v1/system/candidates/:id` | agent, admin |
| GET | `/api/v1/system/candidates/export` | agent, admin |
| GET | `/api/v1/system/config` | admin |
| GET | `/api/v1/system/controls` | admin |
| PUT | `/api/v1/system/controls` | admin |
| GET | `/api/v1/system/dashboard` | admin |
| GET | `/api/v1/system/dashboard-settings` | admin |
| PUT | `/api/v1/system/dashboard-settings` | admin |
| GET | `/api/v1/system/data-policy` | admin |
| PUT | `/api/v1/system/data-policy` | admin |
| GET | `/api/v1/system/deadletters` | admin |
| DELETE | `/api/v1/system/deadletters/:id` | admin |
| POST | `/api/v1/system/deadletters/:id/replay` | admin |
| GET | `/api/v1/system/events` | agent, admin |
| GET | `/api/v1/system/feedback-insights` | agent, admin |
| GET | `/api/v1/system/hw` | admin |
| GET | `/api/v1/system/jobs` | customer, agent, admin |
| POST | `/api/v1/system/jobs/:id/cancel` | customer, agent, admin |
| GET | `/api/v1/system/jobs/stream` | customer, agent, admin |
| GET | `/api/v1/system/manifest` | customer, agent, admin |
| GET | `/api/v1/system/model-runtimes` | admin |
| GET | `/api/v1/system/modules` | admin |
| POST | `/api/v1/system/modules/:id/uninstall` | admin |
| GET | `/api/v1/system/modules/health` | admin |
| GET | `/api/v1/system/retention` | admin |
| POST | `/api/v1/system/retention/run` | admin |
| GET | `/api/v1/system/runs` | agent, admin |
| GET | `/api/v1/system/runs/:id` | agent, admin |
| POST | `/api/v1/system/runs/:id/cancel` | agent, admin |
| GET | `/api/v1/system/runs/:id/graph` | agent, admin |
| GET | `/api/v1/system/storage` | admin |
| GET | `/api/v1/system/update` | admin |
| POST | `/api/v1/system/update/apply` | admin |
| POST | `/api/v1/system/update/check` | admin |
| POST | `/api/v1/system/update/download` | admin |
| GET | `/api/v1/system/usage` | admin |
| GET | `/api/v1/tools` | admin |
| GET | `/healthz` | public |
| GET | `/metrics` | admin |
| GET | `/plugins/:id/:version/:file` | public |
| GET | `/readyz` | public |
| POST | `/v1/a2a/tasks` | key |
| GET | `/v1/a2a/tasks/:id` | key |
| POST | `/v1/chat/completions` | key |
| POST | `/v1/embeddings` | key |
| GET | `/v1/external-agents/handoffs` | key |
| POST | `/v1/external-agents/steps` | key |

<!-- /generated:routes -->
## 3. Output contract
| Output | Path | Gate |
| --- | --- | --- |
| UI data | `packages/contracts` DTO | zod at the DB→HTTP edge |
| Ticket messages | `support` routes/events | state machine + customer visibility |
| Setup/status memory | `base-memory.*`, `system-status`, `skill:*` managed sources | audience filter, read-only, managed key |
| Chat / auto-reply | `chat.reply`, `support.auto_reply` | retrieval, grounding, citation, refusal, policy |
| GitHub / Slack / email / API | adapters/outbox/keys | approval, audit, validation, scoped keys |

Every answer passes the validator (format, grounding, citations, injection,
PII, forbidden topics); actions use the tool contract and approval policy.
## 4. Routing logic
An HTTP request is resolved in order: setup gate → auth guard + RBAC → host page
or manifest module route → workflow dispatch → model call. The engine records
every stage in `workflow_runs`, `stage_runs` and `decision_records`.

Feature graphs: support triage is `load → classify → route → priority → team →
apply → dispatch?` (ambiguity → human review); auto-reply is `load → policy →
retrieve? → generate? → validate? → finalize? → decision → deliver?/clarify?/
escalate?` and never calls the LLM when retrieval is insufficient; chat is
`load → status? → seed? → retrieve? → gate → generate? → validate? → finalize? →
deliver`, with context budgeting/compaction in `load` and a direct chat-only
path; integrations are event → audited action → approval → dispatch → provider
sync, idempotent on retry.

Declared workflows (generated from module registrations):

<!-- generated:workflows -->

| Workflow | Module | Version | Trigger | Stages |
| --- | --- | --- | --- | --- |
| `chat.reply` | chat | 0.2.0 | endpoint | load → status → seed? → retrieve? → gate? → generate? → validate? → finalize? → deliver |
| `echo.run` | echo | 0.1.0 | endpoint | upper → wrap |
| `integrations.github.sync_issue` | integrations-github | 0.1.0 | event | sync |
| `integrations.github.sync_status` | integrations-github | 0.1.0 | event | close |
| `integrations.slack.flush` | integrations-slack | 0.1.0 | schedule | flush |
| `integrations.slack.notify` | integrations-slack | 0.1.0 | event | send |
| `kb.ingest` | kb | 0.2.0 | manual | prepare → embed → index |
| `public_api.completion` | public-api | 0.1.0 | endpoint | retrieve → generate? → validate? → finalize? |
| `support.auto_reply` | support | 0.2.0 | endpoint | load → policy → retrieve? → generate? → validate? → finalize? → decision → deliver? → clarify? → escalate? |
| `support.triage` | support | 0.2.0 | endpoint | load → classify → route → priority → team → apply |

`?` marks a stage with a `when` guard; the full expressions are in the module workflows.

<!-- /generated:workflows -->

Fallbacks: `halt_run`, `return_uncertain`, `request_clarification`,
`escalate_human`, `retry_alternative_retrieval`; model calls use `callModel`.
## 5. Coordination overhead
Teams are bounded by the existing workflow + owner/decision trail. The team
router, handoff caps and 30% overhead alert are wired in the core; prefer a
pipeline over an agent and an agent over a team.
## 6. Inspecting logs
Pino logs carry `reqId`, `runId`, `stageId` and `module`; `/runs/:id` shows
stages, attempts, errors and decision records. Tables: `workflow_runs`,
`stage_runs`, `decision_records`, `queue_jobs`, `queue_deadletters`,
`audit_events` (join `run_id`, then `stage_run_id`). Health: `/metrics`,
`/healthz`, `/readyz`, `/api/v1/system/modules/health`; `/dashboard` links the
tiles. Follow one request by its `runId`. Activity search is Phase 18.6.
## 7. Tracking agents
The agent runtime is a checkpointed loop (bounded steps, persisted decisions);
workflow runs remain the unit of tracking and `/runs` is the inspector. The
board, `/agents` page and watchdog are core seams with partial UI wiring.
## 8. Context awareness
Each call gets a bounded retrieval set (chat defaults to four chunks; support
uses its policy). `packages/rag` builds the prompt with source boundaries and
attaches missing citations (ADR-0014). The shared context packer now assembles
chat as summary → pinned setup/skills → recent turns, with a token budget from
the active window, used/unused accounting and high-water compaction (ADR-0059).
## 9. Observability
Prometheus `/metrics` + the `observ` profile; `/dashboard` aggregates health,
machine, queue, usage, uptime, storage, dead letters and connected APIs (`/system`
redirects there). Every stage writes a decision record. OpenTelemetry is
deferred (ADR-0019); Phase 18.4 reopens it when hosted models, MCP and external
agents add a distributed boundary.
## 10. Model-use strategy
Model names are configuration, never code (ADR-0008); the catalog lives in
`config/model-presets.json` and the wizard picks by hardware tier. Each capability
uses the active preset/overlay adapter.

| Capability | Current adapters |
| --- | --- |
| Embedder | ai-service (sentence-transformers) |
| Classifier | ai-service similarity baseline; registered linear probe |
| Retriever | pgvector threshold + margin gate |
| Generator | Ollama, LM Studio, OpenAI-compatible local server |
| Validator | `@triageai/rag` deterministic checks |
| Model registry | Postgres pointer, eval-gated promote/rollback |
| Hosted LLMs | Anthropic, OpenAI, Google, OpenAI-compatible (opt-in; egress gate + budgets) |

`callModel` owns limits/timeouts/repair/fallbacks and traces; the runtime pool
selects only enabled runtimes and the global/per-runtime switches win before any
network or cache path. Egress wins over cost; measured quality/cost routing and
a lint ban on direct `ChatModel` use remain planned.

Catalog defaults:

<!-- generated:models -->

| Tier | Runtime model | Context | Licence | Note |
| --- | --- | --- | --- | --- |
| generation.small | `qwen2.5:1.5b` | 32,768 | apache-2.0 | Default. Grounded answers verified in Phase 4 evals. |
| generation.small | `llama3.2:1b` | 131,072 | llama3.2 | Smallest option; weaker citation formatting. |
| generation.medium | `qwen2.5:3b` | 32,768 | qwen-research | Better instruction following than 1.5B at modest cost. |
| generation.medium | `llama3.2:3b` | 131,072 | llama3.2 | Long context. |
| generation.medium | `qwen2.5:1.5b` | 32,768 | apache-2.0 | Fastest; the evaluated default. |
| generation.large | `qwen2.5:7b` | 32,768 | apache-2.0 | Strong grounded answers; needs ~6 GB free. |
| generation.large | `llama3.1:8b` | 131,072 | llama3.1 | Long context. |
| generation.large | `qwen2.5:3b` | 32,768 | qwen-research | Lower latency. |
| embedding | `all-MiniLM-L6-v2` | 256 | apache-2.0 | Default; what the classifier evals were run with. |
| embedding | `BAAI/bge-small-en-v1.5` | 512 | mit | Pending decision P1: benchmark before switching. |

<!-- /generated:models -->
## 11. Cost
`cost_ledger` records one row per model call (run, stage, task, provider,
model, tokens in/out/cached). Hosted calls also check
`hosted.budgets.<provider>.dailyTokens` first; at the cap the stage fails
`budget_exceeded` and the workflow fallback runs. Estimated currency cost is 0
until the Phase-19 price table; current local cost is `docs/COST_PER_TICKET.md`.

Planned: price table, per-agent/team roll-ups, forecasts, anomaly alerts and
cache savings. The dashboard cost tile reads the ledger, not a second estimate.
## 12. Efficiency
- **No model where rules suffice:** LLM-free support triage, retrieval
  sufficiency gates, deterministic validators.
- **Small local models first:** the default generator is a 1.5B model; model
  selection is an eval decision.
- **Evals as gates:** classification, retrieval, generation/validation and the
  merged report run in CI; safety regressions block promotion.
- **Bounded context:** four retrieved chunks by default, approved-only.
- **Idempotency:** retries reuse `idempotencyKey` and `runId` guards, so a
  re-delivery does not duplicate side effects.
- **Compaction, not deletion:** chat keeps old messages, compacts older turns
  into a durable structured summary before the window is tight, and falls back
  to deterministic extraction when the summariser is unavailable.
- **Managed memory:** setup identity and operator facts live in read-only KB
  sources (audience-filtered), not injected prompt blobs.

Planned: embedding/retrieval/response/prompt-prefix caches, batching, streaming
for anything a user waits on, token ceilings per task, wasted-token ratio,
coordination overhead and an SLO per lane.
## 13. Where things are
| Path | What |
| --- | --- |
| `packages/kernel` | boot, config, graph, migrations, workflow engine, queue, events, decisions |
| `packages/contracts` | zod DTOs + JSON Schema exports |
| `packages/rag` | prompt boundaries, chunking, grounding, deterministic validation |
| `packages/integrations-core` | audited action rows, approve/reject/retry routes |
| `apps/api` | Fastify host: `src/platform`, `services` (base memory, dashboard reads, runtimes, skills), `routes`, `setup` |
| `apps/web` | React host: manifest gating, module pages, home chat + Skills drawer, `/runs`, `/dashboard`, `/feedback`, `/config` |
| `apps/ai-service` | Python inference: embeddings, classification, hardware probe |
| `modules/*` | `support`, `kb`, `chat`, `ai-pipeline`, `doc-assistant`, `integrations-*`, `echo` |
| `config/presets` | shipped presets below; root `triage.config.json` is the owner's |
| `scripts` | scaffold, backup/restore, seed, this generator |
| `perf/k6`, `docker` | load/chaos suites; images, nginx, Prometheus config |
| `docs` | local-only ADRs, contracts, plan, learnings (gitignored) |

Shipped presets:

<!-- generated:presets -->

| Preset | Profile | Enabled modules | Capability adapters |
| --- | --- | --- | --- |
| `assistant` | assistant | ai-pipeline, chat, doc-assistant, kb | embedder:ai-service, generator:ollama, retriever:pgvector, vectorStore:pgvector |
| `chat-only` | assistant | ai-pipeline, chat | embedder:ai-service, generator:ollama, retriever:pgvector, vectorStore:pgvector |
| `emailer` | support | ai-pipeline, emailer, support | classifier:ai-service, embedder:ai-service |
| `full` | support | ai-pipeline, chat, data-extract, doc-assistant, kb, support | classifier:ai-service, embedder:ai-service, generator:ollama, retriever:pgvector, vectorStore:pgvector |
| `integrations` | support | ai-pipeline, integrations-github, integrations-slack, kb, support | classifier:ai-service, embedder:ai-service, generator:ollama, retriever:pgvector, vectorStore:pgvector |
| `public-api` | assistant | ai-pipeline, public-api | embedder:ai-service, generator:ollama, retriever:pgvector, vectorStore:pgvector |
| `support-autoreply` | support | ai-pipeline, kb, support | classifier:ai-service, embedder:ai-service, generator:ollama, retriever:pgvector, vectorStore:pgvector |
| `support` | support | ai-pipeline, support | classifier:ai-service, embedder:ai-service |

<!-- /generated:presets -->
## 14. Errors and degradation
Every boundary answers with `ErrorEnvelope`
(`{ type, title, status, code, category, retryable, retryAfterMs?, userMessage,
detail?, correlationId }`). Zod failures become 400, framework 4xx statuses are
preserved (429 stays 429), `detail` is admin-only, and free text is scrubbed for
connection strings and tokens. No 5xx body contains a stack trace or a secret.
The web uses the same envelope: typed `apiFetch`, `<ErrorNotice>` and page boundaries.

| Failure | Behaviour |
| --- | --- |
| LLM down / timeout | stage retry/backoff, then the declared fallback (`escalate_human` for auto-reply) |
| ai-service down | support routes to human review; chat refuses; no bare 500 |
| Retrieval insufficient | no LLM call; refusal or human review |
| Validation fails | clarify, refuse or escalate per policy |
| Queue poison job | retries exhaust into `queue_deadletters`; replay is Phase 10C |
| Database down | `/readyz` 503, `/metrics` fails loudly, API returns the envelope |

Phase 10C is complete (ADR-0038): adapters classify 408/429/5xx/4xx/timeout and
honour `Retry-After`; `new Error` is banned in module source and host routes. The
engine retries only retryable categories, opens a 5-failure/30 s circuit per
provider and probes it half-open; dead letters can be replayed or discarded from
`/dashboard` with an audit row. Fatal process faults exit non-zero; `/metrics` only
ignores a missing optional table. Kill switches and the hash-chained audit are
Phase 18.5.
