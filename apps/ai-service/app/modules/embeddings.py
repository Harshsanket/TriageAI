"""Embedder capability implementation: SentenceTransformers (local, offline)."""

from functools import lru_cache
from typing import Iterable

from sentence_transformers import SentenceTransformer

from app.core.config import settings


@lru_cache(maxsize=1)
def get_model() -> SentenceTransformer:
    """Lazy singleton — model loading is expensive, inference is not."""
    return SentenceTransformer(settings.embedding_model, device=settings.embedding_device)


def model_version() -> str:
    return settings.embedding_model


def embed_texts(texts: Iterable[str]) -> list[list[float]]:
    model = get_model()
    vectors = model.encode(
        list(texts),
        normalize_embeddings=True,
        batch_size=settings.embedding_batch_size,
        show_progress_bar=False,
    )
    return [vector.tolist() for vector in vectors]
