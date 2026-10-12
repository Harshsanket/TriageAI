"""
Knowledge retrieval — semantic search over approved knowledge-base chunks.

Ingestion (extract → chunk → embed → pgvector) is orchestrated by apps/api
workers; vector storage lives in Postgres+pgvector. This module owns the
similarity-query logic and sufficiency scoring used by the RAG pipeline
(docs/ARCHITECTURE.md §6.3). Independent of generation so KB updates never
require retraining the generative model.
"""

from app.api.schemas import EmbedResponse

EMBED_MODEL_VERSION = "sentence-transformers/all-MiniLM-L6-v2@Phase1"


def describe() -> str:
    return f"pgvector semantic search over approved chunks (stub, embeddings={EMBED_MODEL_VERSION})"


def embed_for_retrieval(texts: list[str]) -> EmbedResponse:
    raise NotImplementedError("Retrieval embeddings land in Phase 2")
