# TriageAI

Full-stack, production-oriented, AI-powered customer support ticket management and automation platform.

TriageAI receives support tickets, classifies them with a lightweight local ML model (no paid LLM tokens for ordinary routing), routes them through a rules-based routing engine, resolves eligible tickets via a RAG (retrieval-augmented generation) pipeline grounded in a curated knowledge base, and escalates everything else to human support with full context preserved. A later phase adds advanced triage (priority, engineering team assignment) and Slack/GitHub integrations.

**Status:** requirements & architecture definition — no application code yet.

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Functional & non-functional requirements, ticket state machine, out-of-scope items |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, tech choices with rationale, module boundaries, data model, API contracts, AI pipeline design |
| [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) | Phased implementation plan with acceptance criteria and testing strategy |
| [docs/RISKS_AND_OPEN_QUESTIONS.md](docs/RISKS_AND_OPEN_QUESTIONS.md) | Technical risks, mitigations, and decisions awaiting confirmation |

## Planned stack (locked — see ARCHITECTURE.md for rationale)

- **Frontend:** React + TypeScript (Vite), customer / support-agent / admin dashboards
- **Backend:** Node.js + TypeScript (Fastify, Zod, **Drizzle ORM**, PostgreSQL + pgvector, Redis + BullMQ)
- **AI service:** Python (FastAPI, SentenceTransformers) — stateless local inference only
- **AI models (all local, offline after install):** classification via `all-MiniLM-L6-v2` embeddings; RAG generation via small instruct models (SmolLM2-360M-Instruct and 1–2B candidates) through an MLX / LM Studio / Ollama adapter — **no hosted LLM APIs**
- **Testing:** Vitest, pytest, React Testing Library, Playwright; CI via GitHub Actions
- **Target hardware:** MacBook Air M4, 16GB — memory/speed efficiency are design constraints
- **v1 scope:** single-tenant, text-only tickets (no attachments), local-first (deployment deferred)

## Repository layout (planned)

```
apps/
  web/          # React frontend
  api/          # Node.js backend
  ai-service/   # Python ML/AI service
packages/
  shared/       # Shared TypeScript types & contracts
docs/           # Project documentation
```

## License

TBD.
