# TriageAI — Architecture

Source of truth for _how_ the system is built. Requirements live in [REQUIREMENTS.md](./REQUIREMENTS.md). Status: proposed, pre-implementation.

## 1. Architecture style

A **modular monolith backend + one dedicated AI inference service** — not microservices.

```
┌─────────────────────────────────────────────────────────────┐
│  apps/web  (React + TS)                                     │
│  customer · support-agent · admin dashboards                │
└──────────────┬──────────────────────────────────────────────┘
               │ HTTPS / REST (JSON, OpenAPI-typed)
┌──────────────▼──────────────────────────────────────────────┐
│  apps/api  (Node.js + TS, Fastify)                          │
│  auth · tickets · state machine · routing engine (rules)    │
│  knowledge-base mgmt · RAG orchestration · audit · metrics  │
│  ┌────────────────┐   ┌──────────────────────────────────┐  │
│  │ PostgreSQL     │   │ Redis + BullMQ workers           │  │
│  │ (+ pgvector)   │   │ classify · rag · notify jobs     │  │
│  └────────────────┘   └──────────────────────────────────┘  │
└──────────────┬──────────────────────────────────────────────┘
               │ HTTP (internal, typed contracts)
┌──────────────▼──────────────────────────────────────────────┐
│  apps/ai-service  (Python, FastAPI) — stateless inference   │
│  embed · classify (similarity → trained classifier)        │
│  retrieve-support · generate (LLM adapter) · validate       │
└─────────────────────────────────────────────────────────────┘
```

**Why this shape:**

- _Why not pure Node?_ SentenceTransformers / embedding & NLP tooling is Python-first. A separate service keeps the Node API clean and lets the ML stack evolve independently.
- _Why not microservices?_ One developer, portfolio project. A single Node app with clear modules gives 90% of the separation with a fraction of the operational cost. Boundaries (below) are drawn so a module _could_ be extracted later — but we won't pay that cost now.
- _Why is Python "stateless inference only"?_ All business decisions (state machine, routing rules, policy, persistence) stay in Node. Python receives text, returns structured results. This keeps one source of truth for business logic and makes the Node↔Python contract small, testable, and versionable.
- _Why HTTP between Node and Python (not gRPC/queue-only)?_ Classification/embedding are low-latency request/response calls; HTTP + typed schemas (OpenAPI from Pydantic) is debuggable and sufficient. Long/async work (full RAG runs) is _driven by Node workers_ calling Python synchronously — the queue lives in Node where the business workflow lives.

## 2. Tech stack decisions

| Layer              | Choice                                                                           | Alternatives considered                                     | Why                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo           | **pnpm workspaces**                                                              | npm/yarn workspaces, Turborepo                              | pnpm is fast, strict, TS-friendly. Add Turborepo only when build times hurt (avoid premature tooling).                                                                                                                                                                                                                                                                                                                                         |
| API framework      | **Fastify**                                                                      | Express, NestJS                                             | Fast: schema-first, first-class validation/serialization, plugins, TS types via `fastify-type-provider-zod`. NestJS = too much framework for one dev.                                                                                                                                                                                                                                                                                          |
| Validation         | **Zod** (Node) / **Pydantic** (Python)                                           | io-ts, Joi                                                  | Zod is the TS ecosystem standard; shared types generated for the frontend via `packages/shared`.                                                                                                                                                                                                                                                                                                                                               |
| ORM                | **Drizzle ORM** _(decided)_                                                      | Prisma, Knex, raw SQL                                       | Chosen for SQL literacy (explicit project goal): Drizzle generates thin SQL-close queries with full type safety, keeping transactions, indexes, EXPLAIN plans, and optimization visible and teachable. Prisma's query engine hides the SQL mechanics we want to learn.                                                                                                                                                                         |
| DB                 | **PostgreSQL 16 + pgvector**                                                     | Postgres + Pinecone/Weaviate, Mongo                         | One system for relational data _and_ vectors; no extra vector DB until proven necessary. pgvector HNSW is ample at our scale.                                                                                                                                                                                                                                                                                                                  |
| Queue              | **Redis + BullMQ**                                                               | In-process queue, SQS, RabbitMQ                             | Requirements demand durable async processing, retries, backoff, and crash safety (FR-9) from Phase 1. BullMQ is TS-native, Redis is already useful for caching/rate-limits. In-process queues fail the reliability requirement; SQS locks us into AWS.                                                                                                                                                                                         |
| Frontend           | **React 19 + Vite + TS**, TanStack Query, Tailwind + shadcn/ui                   | Next.js, Remix                                              | This is a dashboard-heavy SPA behind auth, not an SEO/marketing site. Vite = simple, fast. Next.js adds server complexity we don't need for the portfolio goal. shadcn/ui = accessible, customizable primitives.                                                                                                                                                                                                                               |
| Auth               | **Custom JWT** (access 15m + refresh rotation, argon2)                           | NextAuth/Lucia/Clerk                                        | Learning value + no vendor lock; requirements are simple (3 roles). Clerk = fastest but hides mechanics; the mechanics _are_ part of the project goal.                                                                                                                                                                                                                                                                                         |
| AI service         | **FastAPI + SentenceTransformers + httpx**                                       | Flask, LangChain as app framework                           | FastAPI gives Pydantic contracts for free. LangChain considered for RAG orchestration — **decision: use it only if a specific feature (e.g. document splitters) clearly pays; default to small explicit code.** Framework abstractions obscure the learning.                                                                                                                                                                                   |
| Embeddings         | **`all-MiniLM-L6-v2`** (384-dim)                                                 | `bge-small-en-v1.5`, `all-mpnet-base-v2`, OpenAI embeddings | MiniLM: 80MB, <50ms CPU, strong STS benchmarks — meets "low latency, minimal memory, zero API cost". bge-small is the closest rival (slightly better retrieval in some benchmarks); mpnet = better quality but 3× size/slower. Swappable behind one interface; benchmark both on _our_ data in Phase 2. OpenAI embeddings rejected for classification: recurring cost + network dependency for the hot path.                                   |
| RAG generation LLM | **Local-only adapter**: MLX, LM Studio, or Ollama (env-selectable) _(decided)_   | Hosted APIs (OpenAI/Anthropic) — rejected                   | Entire AI pipeline must run offline on a MacBook Air M4 (16GB) with zero per-token cost. Adapter: `generate(prompt, context) → {text, usage, model}`. Model chosen empirically in Phase 3: evaluate SmolLM2-360M-Instruct (memory floor) against 1–2B instruct models (e.g. Qwen2.5-1.5B-Instruct, Llama-3.2-1B-Instruct, SmolLM2-1.7B); adopt the _smallest_ model meeting the quality bar — smallest ≠ acceptable is assumed until measured. |
| Testing            | **Vitest** (TS), **pytest** (Python), **RTL** (components), **Playwright** (E2E) | Jest, Mocha                                                 | Vitest = Vite-native, fast. pytest = Python standard. Playwright = best-in-class E2E.                                                                                                                                                                                                                                                                                                                                                          |
| CI                 | **GitHub Actions**                                                               | CircleCI                                                    | Free for public/limited private; native to the repo.                                                                                                                                                                                                                                                                                                                                                                                           |

## 3. Module boundaries (apps/api)

```
src/
  modules/
    auth/          # register, login, refresh, RBAC middleware
    users/         # user & agent management (admin)
    tickets/       # CRUD, messaging, state machine, dedup hooks
    classification/# persist results, expose to UI, override capture
    routing/       # rules engine, policies, reason codes
    knowledge/     # KB docs, ingestion orchestration, approval
    rag/           # orchestration: retrieve → sufficiency → generate → validate → send
    integrations/  # (Phase 8) github/, slack/
    audit/         # append-only audit log
    metrics/       # counters, latency histograms
  workers/         # BullMQ processors: classifyJob, ragJob, notifyJob
  platform/        # db (Prisma), redis, llm adapter, aiClient, config, logging
```

Rules: modules import `platform/*` freely; cross-module imports only via each module's public `index.ts`. No circular deps. Each module owns its Fastify routes + Zod schemas.

## 4. Data model (initial)

```
User            id, email, passwordHash, role[customer|agent|admin], name, createdAt
Ticket          id (ULID), customerId, title, description, status, categoryId?,
                priority?, team?, createdAt, updatedAt
TicketMessage   id, ticketId, authorRole[customer|agent|system], authorId?, body, createdAt
Classification  id, ticketId, category, confidence, modelVersion, method[zero-shot|trained],
                exemplarsUsed?, createdAt
RoutingDecision id, ticketId, decision[auto_rag|human], reasonCodes[], policyVersion, createdAt
KbDocument      id, title, type[faq|troubleshooting|docs|known_issue], status[draft|approved],
                sourceText, uploadedById, version, createdAt
KbChunk         id, documentId, chunkIndex, text, embedding vector(384), metadata jsonb
RagRun          id, ticketId, retrievedChunks [{chunkId, score}], sufficiencyScore,
                promptVersion, llmModel?, generation {text, usage}, validationResults jsonb,
                outcome[escalated|sent], createdAt
Escalation      id, ticketId, fromState, toState, reason, assignedAgentId?, createdAt
AuditEvent      id, actorId?, ticketId?, action, payload jsonb, createdAt
IntegrationLink id, ticketId, platform[github|slack], externalId, url, status, createdAt
Policy          id, category, allowAutomation, thresholds jsonb, version, updatedById
AgentCorrection id, ticketId, field[category|priority|team], oldValue, newValue, agentId, createdAt
```

Notes: embeddings only on `KbChunk` (ticket embeddings computed transiently, cached in Redis for the run). All decision entities (`Classification`, `RoutingDecision`, `RagRun`) are **immutable rows** — corrections create new rows, never overwrite history (audit + retraining data).

## 5. Ticket state machine

```
OPEN ──enqueue──▶ CLASSIFYING ──▶ ROUTING ──▶ RAG_PROCESSING ──▶ AWAITING_CUSTOMER
                     │               │              │                    │
                     │               │              │ insufficient /      │ customer confirms
                     │               │              │ validation fail     ▼
                     │               ▼              ▼               RESOLVED ──▶ CLOSED
                     │          HUMAN_REVIEW ◀──────┘◀── still-need-help
                     ▼
                  HUMAN_REVIEW ──agent resolve──▶ RESOLVED ──▶ CLOSED
```

- Transitions enforced in one table in `modules/tickets/stateMachine.ts`; every transition emits an `AuditEvent`.
- Terminal: `CLOSED`. Error path: `CLASSIFYING`/`RAG_PROCESSING` with retries exhausted → `HUMAN_REVIEW` (never silently stuck).

## 6. AI pipeline design

### 6.1 Classification (local only — zero generative LLM calls)

**Design constraint (product direction):** classification never calls a generative LLM. It is embedding-based, local, low-latency, low-memory, cost-free at inference.

#### Stage 1 (Phase 1): similarity-based ("zero-shot") classification

How it works — no training required:

1. **Exemplar set:** for each category, curate 5–20 short labeled example tickets (from realistic samples / synthetic bootstrap). Embed each once with SentenceTransformers; store as a category prototype matrix (mean of exemplar embeddings = centroid, plus individual exemplars).
2. **Inference:** embed the incoming ticket (title + description). Compute cosine similarity vs. every exemplar/centroid.
3. **Decision:** `score_i = max cosine vs category i`; `category = argmax`, `confidence = score_best`. If `confidence < τ` (threshold) **or** margin `(score_best − score_second) < δ` → `unknown` / uncertain → routing sends to human.
4. **Score semantics (must document in UI/API):** confidence = cosine similarity in [0,1] after `(1+cos)/2` normalization; τ and δ calibrated on a held-out set (Phase 1 delivers an initial calibration notebook/report).

**Why start here:** zero training data needed → unblocks the vertical slice immediately; fully local; deterministic and cheap; failures are measurable and give us the labeled seed data for Stage 2 (agent corrections + evaluation set).

**Limits (why Stage 2 exists):** relies on exemplar quality/coverage; struggles with multi-label or highly varied phrasing; confidence calibration is approximate; adding a category means hand-writing exemplars.

#### Stage 2 (Phase 7): trained classifier on labeled tickets

Data: accumulated `(ticket_text → category)` pairs from Stage 1 runs + agent corrections (high-precision labels) + any external support-ticket datasets we can find/license. Split train/val/test **by time** to avoid leakage.

Candidate methods to evaluate (in order of increasing complexity — each must beat the previous on our held-out set before adoption):

| Method                                                                      | What it is                                                                          | Pros                                                                                        | Cons                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **A. k-NN / centroid on frozen embeddings**                                 | Stage 1, but with hundreds/thousands of real exemplars instead of hand-written ones | Trivial implementation; reuses Stage 1 code; strong baseline                                | Still memory-linear in dataset; no learned decision boundary                                       |
| **B. Linear probe (logistic regression / linear SVM) on frozen embeddings** | Train a shallow classifier on top of frozen MiniLM vectors                          | Very fast inference (~matrix multiply); interpretable weights; tiny model file              | Frozen embeddings may not be linearly separable for fine-grained categories                        |
| **C. SetFit / contrastive fine-tune of the embedding model**                | Fine-tune SentenceTransformer with contrastive loss on labeled pairs, then probe    | Adapts representation to _support-ticket_ domain; big gains typical with few hundred labels | Training complexity, GPU nice-to-have, must version/eval carefully; risk of overfitting small data |
| **D. Fine-tune embedding + classification head end-to-end**                 | Most complete fine-tune                                                             | Max accuracy potential                                                                      | Diminishing returns for our category count; highest ops cost — only if C underperforms materially  |

Evaluation protocol (required for every candidate): macro-F1, per-category precision/recall, confusion matrix, latency p50/p95, model size/RAM, and cost-to-train. Decision rule: adopt the simplest method within ~1–2 F1 points of the best. **Fine-tuning the embedding model (C) is adopted only if it beats B by a meaningful margin on our data** — pretrained embeddings + linear probe are often surprisingly strong; we do not fine-tune for its own sake.

Both stages share one interface (`classify(text) → {category, confidence, method, modelVersion}`) so routing/UI don't change.

### 6.2 Routing (rules, not LLM)

Pure function: `(category, confidence, margin, ticket flags, policy row) → {decision, reasons[]}`. Implemented as an ordered list of rules in `modules/routing` with unit tests per rule. Policies stored in `Policy` table (admin-editable, versioned).

### 6.3 RAG pipeline (separate from classification; LLM pluggable)

Flow for `AUTO_RAG_ELIGIBLE` tickets:

1. **Retrieve:** embed ticket → pgvector similarity top-k (k≈5–8) over **approved** `KbChunk`s only.
2. **Sufficiency gate:** if `best_score < τ_rag` or margin across results too small → escalate _without_ generating (saves tokens, avoids weak answers).
3. **Prompt construction:** system prompt with hard grounding instructions ("answer only from CONTEXT; if not in CONTEXT, say you don't know"), retrieved chunks in delimited blocks, ticket as data. Injection defenses: ticket/KB content is escaped/quarantined in data slots; output scanned against policy regex/PII rules.
4. **Generate:** via **local LLM adapter interface** — no hosted APIs anywhere in the pipeline:
   ```ts
   interface LlmProvider {
     generate(req: {
       prompt: string;
       maxTokens: number;
       model?: string;
     }): Promise<{ text: string; usage: { prompt; completion }; model: string }>;
   }
   ```
   Implementations (env-selectable): `MlxProvider` (in-process MLX on Apple Silicon — target runtime for the final/fine-tuned model), `LmStudioProvider` (OpenAI-compatible local server), `OllamaProvider` (local server). Plain HTTP/SDK calls; no LangChain.
   - **Model selection (Phase 3):** evaluate SmolLM2-360M-Instruct first as the memory-efficiency floor, then 1–2B instruct models; adopt the smallest model meeting the bar (groundedness, instruction-following, response formatting, correct escalation when context is insufficient).
   - **Fine-tuning (later, after baseline):** LoRA/PEFT via Apple's MLX ecosystem to improve instruction-following, context usage, formatting, and insufficient-information handling — **never to memorize the knowledge base**. Retrieval stays independent so KB docs can change without retraining the generator. Fine-tuning starts only after a working RAG pipeline, a representative eval dataset, and a measured baseline identify concrete gaps.
   - **Offline:** after dependencies and model weights are installed, the full pipeline runs with no internet connection.
5. **Validate (deterministic-first):** grounding check (answer claims overlap/NLI vs retrieved text), citation presence, policy checks (forbidden topics, PII, refund promises), length/format. Fail → escalate with reason codes; never send unvalidated output.
6. **Record** full `RagRun` row; set ticket `AWAITING_CUSTOMER`.

**Why separate from classification:** different cost profile, different failure modes, different upgrade cadence; classification is a hard gate that must never depend on generation availability.

## 7. API contracts (sketch)

REST under `/api/v1`, JSON, Zod schemas exported to `packages/shared` for frontend types. Auth: `Authorization: Bearer <access>`.

```
POST   /auth/register | /auth/login | /auth/refresh
GET    /tickets                    (mine | queue for agents; filters, cursor pagination)
POST   /tickets                    → { ticketId, status: OPEN }  (idempotency-key header)
GET    /tickets/:id                → detail + messages + classification summary
POST   /tickets/:id/messages       → customer/agent reply
POST   /tickets/:id/confirm        → { resolved: boolean }  (FR-1.5)
POST   /tickets/:id/override       → agent correction (category/priority/team)
GET    /tickets/:id/ai-context     → agents: full RagRun/classification/routing traces
GET    /admin/users | /admin/policies | /admin/kb ...
POST   /admin/kb                   → upload doc → ingestion job
GET    /healthz | /readyz
```

AI-service internal API (Node ↔ Python, versioned `/ai/v1`):

```
POST /ai/v1/embed        { texts: string[] }           → { vectors: number[][] }
POST /ai/v1/classify     { text: string, topK?: number }→ { category, confidence, margin, method, modelVersion, scores[] }
POST /ai/v1/generate     { prompt, maxTokens, provider? }→ { text, usage, model }   # uses configured adapter
POST /ai/v1/validate     { answer, contextChunks[], policy }→ { passed, failures[] }
```

## 8. Security architecture summary

- RBAC middleware per route (role + ownership checks: customers only see own tickets).
- Argon2id password hashing; refresh-token rotation with reuse detection.
- Rate limiting on auth + ticket creation (Redis token bucket).
- Prompt injection: instruction/data separation, content delimiters, output filters, no tool execution from model output.
- Audit everything consequential; secrets via env only; structured logs with PII redaction.

## 9. Cross-cutting conventions

- Errors: typed `AppError(code, httpStatus, details)`; RFC-7807-style problem responses.
- IDs: ULID (sortable, URL-safe).
- Time: UTC ISO-8601 everywhere.
- Config: typed `config.ts` from env with fail-fast validation (Zod) at boot.
- Logging: pino, request-id + ticket-id correlation.
- Migrations: Drizzle Kit (schema → generated SQL migrations, applied in order); never hand-edit applied migrations; when writing raw SQL via Drizzle's `sql`, read the generated SQL to learn what runs.
