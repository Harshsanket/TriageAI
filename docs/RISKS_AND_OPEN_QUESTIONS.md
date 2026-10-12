# TriageAI — Risks & Open Questions

## 1. Decisions locked (from product direction)

These are settled; revisit only with new information:

- Classification is **local embedding-based only** — no generative LLM calls in the classify path.
- Classification starts **similarity-based (no fine-tune)**; a small trained classifier comes later, and **fine-tuning the embedding model is adopted only if it beats the simpler baseline** on our held-out data.
- RAG generation is **separate** and **provider-pluggable** (hosted OpenAI/Anthropic *or* local Ollama).
- Architecture: modular monolith Node API + stateless Python inference service; Postgres+pgvector; Redis+BullMQ; no unnecessary microservices.
- Primary language: TypeScript/Node; Python only where ML libraries justify it.

## 2. Open questions (need your call before/while building)

| # | Question | Recommendation | Blocks |
| --- | --- | --- | --- |
| Q1 | ORM: Prisma vs Drizzle? | **Prisma** (speed of DX); keep raw SQL escape hatch for pgvector hot queries | Phase 0/1 |
| Q2 | Default RAG LLM for development: OpenAI vs Anthropic vs local-only Ollama to start? | **One hosted (OpenAI or Anthropic) + Ollama adapter from day one**; hosted for eval quality | Phase 3 |
| Q3 | Ticket attachments (screenshots/files) in scope for v1? | **Defer** — text-only v1; add object storage later | FR-1 scope |
| Q4 | Single-tenant confirmed? (all customers share one org) | **Yes for v1** — keep `organizationId`-shaped schemas only if free | Data model |
| Q5 | Seed labeled data source for Stage-2 classifier: synthetic only vs find a public support-ticket dataset? | **Synthetic + corrections first**; evaluate public datasets (licenses!) in Phase 7 | Phase 7 |
| Q6 | Phase 6 (deployment) before or after Phase 7 (advanced triage)? | **After Phase 5 → straight to 7**; deploy when the demo needs it | Sequencing |
| Q7 | Embedding model final call: MiniLM-L6 vs bge-small-en-v1.5? | **MiniLM first**, benchmark bge on our chunks in Phase 2 | Phase 2 |
| Q8 | Do you want a public repo or keep private for now? | Portfolio value favors **public** eventually; stay private until Phase 3 demo is presentable | — |

## 3. Technical risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Scope overrun** — platform is 8–9 phases of work | High | High | Phased plan with hard AC gates; vertical slices; explicit non-goals; cut Phase 6 or polish before cutting tests |
| **Zero-shot classifier accuracy too low** | Medium | Medium | Generous exemplar sets per category; margin-based uncertainty; fallback to human is *correct* behavior, not failure; Stage 2 planned with real labels |
| **Insufficient labeled data for Stage 2** | Medium | Medium | Agent corrections are first-class training data (FR-10); synthetic bootstrap; time-based splits; accept k-NN baseline if probe doesn't clearly win |
| **RAG hallucination reaching customers** | Medium | **High** | Deterministic validation gate; sufficiency check before generation; escalate-on-doubt; golden-set eval in CI measuring unsupported-claim rate; human-in-the-loop via customer confirmation |
| **Prompt injection via ticket text or KB docs** | Medium | High | Instruction/data separation, delimiters, output policy filters, no tool execution from model output, KB approval workflow, adversarial fixtures in tests |
| **Cost blowout from LLM calls** | Low-Med | Medium | Classification never calls LLM (architecture); sufficiency gate skips weak retrieval; token/cost metrics per ticket from Phase 3; daily budget alerts later |
| **Dual-language ops friction** (two runtimes, two test systems, contract drift) | Medium | Medium | Tiny versioned `/ai/v1` contract; contract tests in CI; docker-compose for local parity; keep Python stateless & thin |
| **BullMQ/Redis early complexity** | Low | Medium | Requirements demand durability from day 1; wrap queue behind `platform/queue` interface; start with one queue + one worker per job type |
| **Prisma + pgvector friction** | Low-Med | Medium | `$queryRaw` for vector ops if needed; Drizzle/SQL fallback documented; spike pgvector+Prisma in Phase 0/2 |
| **Calibration of confidence thresholds** | Medium | Low-Med | Explicit calibration step in Phase 1 with report; treat thresholds as config, not code |
| **Learning-curve stalls** (Python/ML unfamiliar) | Medium | Medium | Each phase lists skills; docs explain concepts before code; keep Python surface minimal (inference client + model wrapper) |
| **"Works but unmaintainable" code** | Medium | High | Module rules, typed errors, AC-gated phases, code review checklist, no speculative abstraction, tests as spec |

## 4. What we are deliberately NOT doing

- Fine-tuning or hosting a generative LLM for classification.
- Introducing a standalone vector database (Pinecone etc.) before pgvector proves insufficient.
- Microservices beyond the single Python inference boundary.
- LangChain as the application framework (small explicit code first).
- Real-time websocket chat (async messaging model is sufficient for v1).
- Mobile clients, multi-tenancy, SLA/billing.

## 5. How decisions get recorded

Significant choices get a short ADR in `docs/adr/NNNN-title.md` (context, decision, consequences) once implementation starts. This file tracks the *pre-implementation* risk/question register; update it whenever an open question closes.
