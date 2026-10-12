"""
Ticket classification — Stage 1 (Phase 1): similarity-based zero-shot.

Plan (docs/ARCHITECTURE.md §6.1):
  1. Embed the ticket with a pretrained SentenceTransformers model
     (all-MiniLM-L6-v2). No generative LLM is involved, ever.
  2. Compare the ticket embedding against curated category exemplars
     via cosine similarity.
  3. Return category, confidence (normalized cosine), and margin
     (confidence - runner-up) so routing can escalate uncertain cases.

Stage 2 (Phase 7) trains a small classifier on labeled tickets and is
selected by measured macro-F1 / latency / memory — see the plan doc.

This module is intentionally a stub in Phase 0; the HTTP contract above
is already fixed so apps/api can be built against it.
"""

from app.api.schemas import ClassifyResponse, EmbedResponse

MODEL_VERSION = "stub-0"

CATEGORIES = [
    "general_question",
    "known_troubleshooting",
    "feature_question",
    "billing",
    "bug_report",
    "security",
    "account",
    "refund_dispute",
    "unknown",
]


def classify(text: str) -> ClassifyResponse:
    raise NotImplementedError("Stage 1 classifier lands in Phase 1")


def embed(texts: list[str]) -> EmbedResponse:
    raise NotImplementedError("Embedding endpoint lands in Phase 1")


def describe() -> str:
    return f"similarity-zero-shot (stub, model={MODEL_VERSION}, categories={len(CATEGORIES)})"
