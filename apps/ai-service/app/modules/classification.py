"""
Similarity classification (Phase 3): embeddings + cosine similarity against
curated per-category exemplars. No generative LLM is involved, ever.

Confidence = best cosine similarity; margin = best - runner-up. When either
falls below its threshold the result is `unknown` so routing escalates to
human review (per-category thresholds live in the support module config).
"""

import json
from functools import lru_cache
from pathlib import Path

from app.api.schemas import CategoryScore, ClassifyResponse, EmbedResponse
from app.core.config import settings
from app.modules import embeddings

DEFAULT_EXEMPLARS_PATH = Path(__file__).resolve().parent.parent / "data" / "exemplars.json"


def load_exemplars() -> dict[str, list[str]]:
    path = Path(settings.exemplars_path) if settings.exemplars_path else DEFAULT_EXEMPLARS_PATH
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def exemplar_vectors() -> dict[str, list[list[float]]]:
    exemplars = load_exemplars()
    return {category: embeddings.embed_texts(texts) for category, texts in exemplars.items()}


def reset_cache() -> None:
    exemplar_vectors.cache_clear()


def _dot(a: list[float], b: list[float]) -> float:
    return float(sum(x * y for x, y in zip(a, b, strict=True)))


def embed(texts: list[str]) -> EmbedResponse:
    return EmbedResponse(vectors=embeddings.embed_texts(texts), model_version=embeddings.model_version())


def classify(text: str) -> ClassifyResponse:
    vector = embeddings.embed_texts([text])[0]
    scores = [
        CategoryScore(category=category, score=max(0.0, min(1.0, max(_dot(vector, exemplar) for exemplar in vectors))))
        for category, vectors in exemplar_vectors().items()
    ]
    scores.sort(key=lambda item: item.score, reverse=True)
    best = scores[0]
    runner_up = scores[1] if len(scores) > 1 else None
    margin = best.score - (runner_up.score if runner_up else 0.0)

    below_threshold = best.score < settings.classifier_threshold
    below_margin = margin < settings.classifier_margin
    category = "unknown" if (below_threshold or below_margin) else best.category

    return ClassifyResponse(
        category=category,
        confidence=round(best.score, 4),
        margin=round(margin, 4),
        method="zero-shot",
        model_version=embeddings.model_version(),
        scores=scores,
    )


def describe() -> str:
    return f"similarity-zero-shot (model={embeddings.model_version()}, categories={len(load_exemplars())})"
