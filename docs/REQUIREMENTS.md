# TriageAI — Requirements

This document defines what TriageAI must do. It is the source of truth for scope; changes go through here first.

## 1. Problem statement

Customer support teams face a flood of tickets of wildly uneven complexity: simple FAQ/known-issue questions that waste agent time, and rare critical incidents that must be escalated immediately. Human triage is slow, inconsistent, and expensive; naive "AI support" that sends every ticket to a paid LLM is costly and hallucination-prone.

TriageAI solves this by:

1. **Classifying** every ticket with a cheap local model (no LLM tokens spent on routing).
2. **Routing** with deterministic, configurable rules — not an LLM.
3. **Resolving only eligible tickets** via a RAG pipeline strictly grounded in an approved knowledge base, with deterministic response validation before anything reaches the customer.
4. **Escalating everything uncertain or sensitive** to humans with complete context (classification, retrieval traces, generated drafts, reasons) so agents never start from zero.
5. (Phase 7+) **Extending triage** to priority assessment, engineering team assignment, and GitHub/Slack integration, turning the product into a support-operations platform.

Success means: high automated-resolution rate for routine tickets, near-zero unsupported AI claims, low cost per ticket, and measurable improvement over time from human corrections.

## 2. Personas

| Persona           | Goals                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| **Customer**      | Create tickets, track status, read/reply to responses, confirm whether a proposed solution worked  |
| **Support agent** | Work a queue of human-review tickets with full AI context, reply, correct classifications, resolve |
| **Administrator** | Manage users/agents, categories, routing policies, knowledge base, integrations, settings          |

## 3. Functional requirements

### FR-1 Ticket intake (customer)

- FR-1.1 Customers can register/log in and create tickets (title, description). **Attachments (screenshots, images, PDFs) are deferred for v1** — text-only tickets. The data model and APIs must reserve room for attachments later (e.g. an `TicketAttachment` entity/interface stub) without implementing upload now.
- FR-1.2 System validates input, generates a unique ticket ID, stores the original ticket with status `OPEN`, and enqueues asynchronous processing. Ticket creation must be idempotent (no duplicate tickets from retries).
- FR-1.3 Customers can view their ticket history, current status, full conversation, and classification summary (plain-language category, not internal scores). _(Ticket detail APIs/UI leave room for a future attachments list without exposing upload yet.)_
- FR-1.4 Customers can reply to a ticket at any point.
- FR-1.5 After an automated reply, the customer can confirm "this solved my issue" or "still need help". Confirmation → `RESOLVED`; still-need-help → escalate to human (`HUMAN_REVIEW`) — the system must not re-send the same failed solution.
- FR-1.6 If a customer opens a new ticket about an same/overlapping issue, the system links it to prior tickets (Phase 7 deduplication; basic manual visibility earlier).

### FR-2 Classification pipeline

- FR-2.1 Every ticket passes through a lightweight classifier **before** any LLM call. Goal: classify with zero paid tokens for ordinary tickets.
- FR-2.2 Method (phased):
  - **Phase 1:** embedding-similarity ("zero-shot") classification — embed ticket text, compare against labeled category exemplars, pick best match above threshold.
  - **Phase 7+:** trained classifier (e.g. SetFit / logistic-regression head on frozen embeddings) seeded with labeled data from Phase 1 and agent corrections.
- FR-2.3 Categories (initial, configurable): general question, known troubleshooting, feature question, billing, bug report, security issue, account problem, refund dispute, unknown.
- FR-2.4 Classification result = `{ category, confidence, model_version }` with a **documented score semantics** (e.g. cosine similarity mapped to confidence; threshold τ below which = `unknown`/uncertain).
- FR-2.5 Classification inputs/outputs and model version are persisted for audit, evaluation, and retraining.
- FR-2.6 Latency and resource budgets: classification must run on commodity hardware / small container without GPU (target defined in Phase 1; measure p50/p95).

### FR-3 Routing engine

- FR-3.1 Routing is a **deterministic rules engine** (no generative LLM) consuming: category, confidence, escalation policies, security rules, ticket metadata.
- FR-3.2 Output: `AUTO_RAG_ELIGIBLE` or `HUMAN_REVIEW` (with reason codes).
- FR-3.3 Mandatory human-review rules: security issues, refund disputes, sensitive account actions, `unknown` category, confidence below threshold, any category whose policy forbids automation.
- FR-3.4 Policies are configurable per category (stored in DB, editable by admins, versioned). Policy changes are audited.
- FR-3.5 Routing decisions are persisted with inputs for audit and evaluation.

### FR-4 Knowledge base & RAG pipeline

- FR-4.1 Admins can upload/approve knowledge-base documents: product docs, FAQs, troubleshooting guides, known issues, verified resolved tickets (approved by agents).
- FR-4.2 Ingestion pipeline: extract text → chunk → embed → store in pgvector with metadata (doc id, section, version, approved flag).
- FR-4.3 For an eligible ticket: embed ticket → semantic search top-k chunks → **sufficiency check** (score margin / threshold) → if insufficient, escalate _without_ calling the LLM → else build grounded prompt with retrieved context → generate response.
- FR-4.4 Generated responses must be **grounded**: the model may only use retrieved information; no invented troubleshooting steps. Prompt design treats ticket text and retrieved docs as untrusted data (prompt-injection defenses, see FR-8).
- FR-4.5 **Response validation before send** (deterministic where possible): retrieved-context support check (e.g. NLI/overlap heuristics + citation presence), policy checks (no promises of refunds, no security advice beyond policy, no PII leakage), and quality gates. On failure → escalate, do not send.
- FR-4.6 Validated reply is sent to the customer; ticket → `AWAITING_CUSTOMER`. Automated reply never auto-resolves the ticket (FR-1.5).
- FR-4.7 Every RAG run persists: retrieved chunk ids + scores, prompt version, model + params, output, validation results — for debugging, eval, and agent context.
- FR-4.8 **Generation is local-only**: no hosted LLM APIs (OpenAI/Anthropic/etc.) anywhere in the pipeline. Inference runs via a configurable local adapter (MLX, LM Studio, or Ollama). After dependencies and model weights are installed, the AI pipeline works **without an internet connection**. Target hardware: MacBook Air M4, 16GB unified memory — memory efficiency, inference speed, and resource consumption are design constraints.
- FR-4.9 Knowledge retrieval is **independent of generation**: KB documents can be updated/re-ingested without retraining or reconfiguring the generative model. Any later fine-tuning of the generator targets instruction-following/context-usage/formatting/escalation behavior — never memorizing KB content.

### FR-5 Human support workflow

- FR-5.1 Agents see a queue of `HUMAN_REVIEW` tickets with full context: original message, classification, routing reason, retrieved docs, AI draft (if any), customer replies, prior linked tickets.
- FR-5.2 Agents can reply, change status, reassign, override classification/category/priority (overrides audited; feed future training data).
- FR-5.3 Escalation must never lose information; agents resume, not restart.

### FR-6 Ticket state machine

States: `OPEN → CLASSIFYING → ROUTING → RAG_PROCESSING → AWAITING_CUSTOMER | HUMAN_REVIEW → RESOLVED → CLOSED` (plus terminal/error variants as needed).

- Allowed transitions are enforced server-side (single source of truth, e.g. transition table).
- Illegal transitions return a typed error; all transitions are audited.
- `RESOLVED` requires customer confirmation (FR-1.5) or explicit agent action. `CLOSED` = no further activity (auto after inactivity window or agent action).

### FR-7 Administration

- Manage users & agents (roles: `customer`, `agent`, `admin`), categories, routing policies, knowledge-base documents, integration settings (Phase 8), system settings (thresholds, model versions, LLM provider config).
- View metrics dashboards (FR-11).

### FR-8 Security & privacy (non-negotiable, from day one)

- Authentication (JWT access + refresh, hashed passwords), role-based authorization enforced on every route.
- Input validation everywhere (Zod on API, Pydantic on AI service).
- Customer messages and KB documents are **untrusted input**: prompt-injection defenses (delimiters, instruction/data separation, output filters); no cross-tenant data exposure (single-tenant initially, but retrieval scoped strictly by design).
- Secrets never in logs; PII handling policy defined (retention, redaction in logs).
- Audit log for: classification, routing, automated replies, overrides, assignments, status changes, policy changes, integration actions.

### FR-9 Background processing & reliability

- Async via Redis + BullMQ (introduced at Phase 1 — async is a requirement, not an optimization).
- Retries with backoff for transient failures (LLM timeout, Python service down); idempotency keys to prevent duplicate processing/replies.
- Timeouts on every external call; dead-letter handling; worker crash safety (jobs at-least-once + idempotent handlers).
- External API failures (Phase 8: Slack/GitHub) must never destroy or corrupt ticket state.

### FR-10 Extensibility (designed-for in Phase 1, built in Phases 7–8)

- **Advanced classifier:** priority (P0–P3 by impact/severity/urgency/availability — not keywords/tone), technical category (frontend/backend/db/infra/auth/payment/security/performance), team assignment (configurable mapping; ambiguous → manual triage).
- **Integrations:** GitHub issue creation (structured: title, description, repro steps _only if present in ticket_, labels, ticket link; duplicate detection before create), Slack notifications (configurable policy: critical = immediate, others batched/reviewed), bidirectional status sync with conflict rules, human approval gates for high-impact actions, full audit of attempts/failures.
- Corrections by agents (category, priority, team) recorded as labeled data for model improvement.

### FR-11 Observability & metrics

- Structured logs (JSON, correlation ids per request/ticket), health checks (`/healthz`, `/readyz`), error tracking hooks.
- Metrics: ticket processing latency, classification latency, retrieval latency, LLM latency, token consumption, cost/ticket, escalation rate, auto-reply rate, verified auto-resolution rate, system failure rate, (Phase 7+) team-assignment accuracy, duplicate-issue rate, integration success rate.

### FR-12 Testing (mandatory throughout, not bolted on)

- Unit tests: business rules, state machine, routing, validation.
- Integration tests: DB, Node↔Python contract, queue behavior.
- API tests: all endpoints.
- Frontend: component tests (React Testing Library).
- E2E: Playwright — customer create→auto-resolve flow; customer create→escalate→agent resolve flow.
- ML evals: classifier (precision/recall/F1/confusion matrix on held-out labeled set); RAG (retrieval recall@k, answer groundedness, unsupported-claim rate).
- Failure tests: LLM down, KB empty, bad classification, invalid payloads, DB down, duplicate deliveries.
- CI (GitHub Actions) blocks merge on failing required tests.

### FR-13 Local development & delivery

- Reproducible setup: `docker compose up` for Postgres(+pgvector), Redis; documented env config (`.env.example` per app).
- AI models are downloaded/cached locally once; no internet required at runtime.
- **Deployment is deferred** (originally Phase 6) until after the core phases and advanced triage/integrations are functional and tested. Local-first: reliable Docker Compose environment, env-based config, automated tests, GitHub Actions CI. Deployment returns to the plan after Phase 8.

## 4. Explicit non-goals (initial release)

- Multi-tenancy (**single-tenant v1**: one organization with multiple customers, agents, admins, and internal teams; proper RBAC maintained; avoid schema/API decisions that would make later multi-tenancy unnecessarily hard, but do not build it), mobile apps, real-time chat/video, SLA billing, marketplace integrations beyond Slack/GitHub, training/fine-tuning large LLMs, GPU-dependent inference, **attachment uploads (text-only tickets in v1)**.

## 5. Quality attributes (priority order)

1. **Correctness & safety** — no unsupported AI replies reach customers.
2. **Cost efficiency** — zero LLM tokens for routing; zero per-token inference cost overall (all-local AI); RAG only when eligible and retrieval is sufficient.
3. **Testability** — every rule unit-testable; ML measurable.
4. **Maintainability** — small modules, explicit types, no speculative abstraction.
5. **Learnability** — each phase teaches a concrete skill; comments/docs explain _why_.
6. **Performance** — classify < 500ms p95 target; full auto-resolution path measured, not guessed.
