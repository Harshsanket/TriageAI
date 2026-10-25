"""Linear-probe classifier backend (Phase 7).

A trained classifier is a portable JSON artifact: frozen MiniLM embeddings plus
logistic-regression weights. The host resolves the active model registry pointer
and sends the artifact ref with the classify request; this module loads the
artifact under the configured artifacts directory and never executes trainer
code (the serving path imports only this file).

Artifact shape (written by `train.linear_probe`):

    {
      "kind": "linear-probe",
      "modelVersion": "linear-probe-v1-abcdef12",
      "embeddingModel": "all-MiniLM-L6-v2",
      "classes": ["billing", "security"],
      "coef": [[...], [...]],
      "intercept": [...]
    }
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.api.schemas import CategoryScore, ClassifyResponse
from app.core.config import settings
from app.modules import embeddings


class ModelArtifactError(RuntimeError):
    """Typed failure for a missing/invalid model artifact (surfaced as 503)."""


def _artifacts_root() -> Path:
    return Path(settings.artifacts_dir).resolve()


def resolve_artifact(artifact_ref: str) -> Path:
    """Resolve a registry artifact ref under ARTIFACTS_DIR.

    Relative refs may name a directory (`probe-v1` → `probe-v1/model.json`) or a
    file. Absolute refs are accepted only inside the artifacts root; the service
    never reads arbitrary filesystem paths from a request.
    """
    if not artifact_ref or not artifact_ref.strip():
        raise ModelArtifactError("empty artifact reference")
    root = _artifacts_root()
    candidate = Path(artifact_ref)
    path = candidate if candidate.is_absolute() else root / candidate
    try:
        path = path.resolve()
    except OSError as err:  # pragma: no cover - defensive
        raise ModelArtifactError(f"cannot resolve artifact {artifact_ref!r}: {err}") from None
    if path != root and root not in path.parents:
        raise ModelArtifactError(
            f"artifact {artifact_ref!r} is outside the configured artifacts directory"
        )
    if path.is_dir() or path.suffix == "":
        path = path / "model.json"
    if not path.is_file():
        raise ModelArtifactError(f"model artifact not found: {path}")
    return path


@lru_cache(maxsize=8)
def _load(path: str, mtime_ns: int) -> dict[str, Any]:
    artifact = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(artifact, dict):
        raise ModelArtifactError(f"model artifact {path} is not a JSON object")
    if artifact.get("kind") != "linear-probe":
        raise ModelArtifactError(f"model artifact {path} is not a linear-probe model")
    classes = artifact.get("classes")
    coef = artifact.get("coef")
    intercept = artifact.get("intercept")
    if not isinstance(classes, list) or not classes:
        raise ModelArtifactError(f"model artifact {path} has no classes")
    if not isinstance(coef, list) or len(coef) != len(classes):
        raise ModelArtifactError(f"model artifact {path} has invalid coefficients")
    if not isinstance(intercept, list) or len(intercept) != len(classes):
        raise ModelArtifactError(f"model artifact {path} has invalid intercepts")
    return artifact


def load_artifact(artifact_ref: str) -> dict[str, Any]:
    path = resolve_artifact(artifact_ref)
    stat = path.stat()
    return _load(str(path), stat.st_mtime_ns)


def reset_cache() -> None:
    _load.cache_clear()


def _softmax(logits: list[float]) -> list[float]:
    peak = max(logits)
    exps = [math.exp(value - peak) for value in logits]
    total = sum(exps)
    return [value / total for value in exps]


def classify(text: str, artifact_ref: str) -> ClassifyResponse:
    artifact = load_artifact(artifact_ref)
    vector = embeddings.embed_texts([text])[0]
    coef: list[list[float]] = artifact["coef"]
    intercept: list[float] = artifact["intercept"]
    if not coef or len(coef[0]) != len(vector):
        raise ModelArtifactError(
            f"model artifact dimension {len(coef[0]) if coef else 0} does not match "
            f"embedding dimension {len(vector)}"
        )

    logits = [
        sum(weight * value for weight, value in zip(row, vector, strict=True)) + bias
        for row, bias in zip(coef, intercept, strict=True)
    ]
    probabilities = _softmax(logits)
    scored = sorted(
        (
            CategoryScore(category=str(category), score=round(probability, 4))
            for category, probability in zip(artifact["classes"], probabilities, strict=True)
        ),
        key=lambda item: item.score,
        reverse=True,
    )
    best = scored[0]
    runner_up = scored[1] if len(scored) > 1 else None
    margin = best.score - (runner_up.score if runner_up else 0.0)
    below_threshold = best.score < settings.classifier_threshold
    below_margin = margin < settings.classifier_margin
    category = "unknown" if (below_threshold or below_margin) else best.category

    return ClassifyResponse(
        category=category,
        confidence=round(best.score, 4),
        margin=round(margin, 4),
        method="trained",
        model_version=str(artifact.get("modelVersion") or f"linear-probe:{artifact_ref}"),
        scores=scored,
    )


def describe(artifact_ref: str | None = None) -> str:
    if not artifact_ref:
        return "linear-probe (no artifact configured)"
    artifact = load_artifact(artifact_ref)
    return (
        f"linear-probe (model={artifact.get('modelVersion')}, "
        f"classes={len(artifact.get('classes', []))})"
    )
