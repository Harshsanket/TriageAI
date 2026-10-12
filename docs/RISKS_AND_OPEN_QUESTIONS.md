# TriageAI — Risks & Open Questions

## 1. Decisions locked (from product direction)

These are settled; revisit only with new information:

- Classification is **local embedding-based only** — no generative LLM calls in the classify path.
- Classification starts **similarity-based (no fine-tune)**; a small trained classifier comes later, and **fine-tuning the embedding model is adopted only if it beats the simpler baseline** on our held-out data.
- RAG generation is **separate** and **provider-pluggable** (hosted OpenAI/Anthropic _or_ local Ollama).
- Architecture: modular monolith Node API + stateless Python inference service; Postgres+pgvector; Redis+BullMQ; no unnecessary microservices.
- Primary language: TypeScript/Node; Python only where ML libraries justify it.
- **ORM: Drizzle** (SQL literacy is a project goal — transactions, indexing, EXPLAIN, optimization stay visible).
- **All AI inference is local** (MLX / LM Studio / Ollama adapters) — no hosted LLM APIs, no per-token charges; offline after deps/models installed. Target hardware: MacBook Air M4, 16GB.
- **Generative model selection is empirical**: evaluate SmolLM2-360M-Instruct and 1–2B instruct models; adopt the _smallest_ model meeting the quality bar; never assume smallest = good enough; never default to a large general-purpose model.
- **Fine-tuning (LoRA via MLX) comes after** a working RAG pipeline + eval dataset + baseline measurements; it improves instruction/context/format/escalation behavior — never KB memorization.
- **Single-tenant v1** (one org, many users/agents/teams, proper RBAC).
- **Attachments deferred** (text-only tickets; data model leaves room for later).
- **Deployment deferred** until after Phase 8; local-first with Compose + CI.
- **Repo stays private** until the Phase 3 demo is working, tested, and reviewed (code, docs, config, security, presentation).

## 2. Open questions

Closed by product decision (was Q1–Q4, Q6, Q8): Drizzle; local-only LLMs; attachments deferred; single-tenant yes; deployment after Phase 8; repo private until Phase 3 review.

| #   | Question                                                                                            | Recommendation                                                                              | Blocks  |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------- |
| Q5  | Seed labeled data source for Stage-2 classifier: synthetic only vs a public support-ticket dataset? | **Synthetic + corrections first**; evaluate public datasets (check licenses!) in Phase 7    | Phase 7 |
| Q7  | Embedding model final call: MiniLM-L6 vs bge-small-en-v1.5?                                         | **MiniLM first**, benchmark bge on our chunks in Phase 2                                    | Phase 2 |
| Q9  | Which local generation candidates beyond SmolLM2/Qwen/Llama (e.g. gemma-2-2b-it, Phi-3.5-mini)?     | Finalize candidate list in Phase 3 from Ollama/MLX availability on Apple Silicon + licenses | Phase 3 |

## 3. Technical risks & mitigations

| Risk                                                                                                                            | Likelihood  | Impact   | Mitigation                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Scope overrun** — platform is 8–9 phases of work                                                                              | High        | High     | Phased plan with hard AC gates; vertical slices; explicit non-goals; cut Phase 6 or polish before cutting tests                                                                                                                            |
| **Zero-shot classifier accuracy too low**                                                                                       | Medium      | Medium   | Generous exemplar sets per category; margin-based uncertainty; fallback to human is _correct_ behavior, not failure; Stage 2 planned with real labels                                                                                      |
| **Insufficient labeled data for Stage 2**                                                                                       | Medium      | Medium   | Agent corrections are first-class training data (FR-10); synthetic bootstrap; time-based splits; accept k-NN baseline if probe doesn't clearly win                                                                                         |
| **RAG hallucination reaching customers**                                                                                        | Medium      | **High** | Deterministic validation gate; sufficiency check before generation; escalate-on-doubt; golden-set eval in CI measuring unsupported-claim rate; human-in-the-loop via customer confirmation                                                 |
| **Prompt injection via ticket text or KB docs**                                                                                 | Medium      | High     | Instruction/data separation, delimiters, output policy filters, no tool execution from model output, KB approval workflow, adversarial fixtures in tests                                                                                   |
| **Cost blowout from LLM calls**                                                                                                 | Low         | Medium   | Classification never calls an LLM (architecture); all inference is local (zero per-token cost); sufficiency gate skips weak retrieval; token/latency/memory metrics per ticket from Phase 3                                                |
| **Local small-model quality insufficient for grounded replies** (360M–2B models may ignore context, ramble, or fail formatting) | Medium-High | High     | Empirical model comparison in Phase 3 with explicit quality bar; escalate-by-default on validation failure; sufficiency gate before generation; Phase 7b LoRA fine-tuning targets exactly these failure modes; keep human loop as backstop |
| **16GB memory contention** (embedding model + generative model + app + browser on one machine)                                  | Medium      | Medium   | Size cap ~2B for generation; load models lazily; measure peak RSS in eval; Ollama/MLX unload idle models; run evals with other heavy apps closed                                                                                           |
| **MLX ecosystem learning curve** (new framework, Apple Silicon–specific)                                                        | Medium      | Medium   | Ollama adapter first for pipeline development (works today); MLX adapter targeted at Phase 3 end / Phase 7b; keep adapter interface thin so runtime swap is cheap                                                                          |
| **Dual-language ops friction** (two runtimes, two test systems, contract drift)                                                 | Medium      | Medium   | Tiny versioned `/ai/v1` contract; contract tests in CI; docker-compose for local parity; keep Python stateless & thin                                                                                                                      |
| **BullMQ/Redis early complexity**                                                                                               | Low         | Medium   | Requirements demand durability from day 1; wrap queue behind `platform/queue` interface; start with one queue + one worker per job type                                                                                                    |
| **Prisma + pgvector friction**                                                                                                  | Low-Med     | Medium   | `$queryRaw` for vector ops if needed; Drizzle/SQL fallback documented; spike pgvector+Prisma in Phase 0/2                                                                                                                                  |
| **Calibration of confidence thresholds**                                                                                        | Medium      | Low-Med  | Explicit calibration step in Phase 1 with report; treat thresholds as config, not code                                                                                                                                                     |
| **Learning-curve stalls** (Python/ML unfamiliar)                                                                                | Medium      | Medium   | Each phase lists skills; docs explain concepts before code; keep Python surface minimal (inference client + model wrapper)                                                                                                                 |
| **"Works but unmaintainable" code**                                                                                             | Medium      | High     | Module rules, typed errors, AC-gated phases, code review checklist, no speculative abstraction, tests as spec                                                                                                                              |

## 4. What we are deliberately NOT doing

- Fine-tuning or hosting a generative LLM for classification.
- Hosted LLM APIs (OpenAI/Anthropic/etc.) — the pipeline is local-only.
- Introducing a standalone vector database (Pinecone etc.) before pgvector proves insufficient.
- Microservices beyond the single Python inference boundary.
- LangChain as the application framework (small explicit code first).
- Real-time websocket chat (async messaging model is sufficient for v1).
- Mobile clients, multi-tenancy, SLA/billing, attachment uploads.
- Production deployment (until after Phase 8).
- Fine-tuning the generative model before a working RAG baseline exists.

## 5. How decisions get recorded

Significant choices get a short ADR in `docs/adr/NNNN-title.md` (context, decision, consequences) once implementation starts. This file tracks the _pre-implementation_ risk/question register; update it whenever an open question closes.
