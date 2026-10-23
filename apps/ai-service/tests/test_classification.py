"""Classification logic tests with a deterministic fake embedder (no model load)."""

import pytest

from app.modules import classification


def fake_embed(texts: list[str]) -> list[list[float]]:
    # 2-d vectors: billing-ish texts map near (1, 0), security-ish near (0, 1).
    table = {
        "invoice please": [1.0, 0.0],
        "my card was charged twice": [1.0, 0.0],
        "someone hacked my account": [0.0, 1.0],
        "totally unrelated gibberish": [0.7071, 0.7071],
    }
    return [table.get(text, [0.7071, 0.7071]) for text in texts]


@pytest.fixture(autouse=True)
def fake_encoder(monkeypatch):
    monkeypatch.setattr(classification.embeddings, "embed_texts", fake_embed)
    monkeypatch.setattr(classification.embeddings, "model_version", lambda: "fake-mini")
    monkeypatch.setattr(
        classification,
        "exemplar_vectors",
        lambda: {"billing": [[1.0, 0.0]], "security": [[0.0, 1.0]]},
    )
    yield


def test_classify_picks_best_category() -> None:
    result = classification.classify("invoice please")
    assert result.category == "billing"
    assert result.method == "zero-shot"
    assert result.model_version == "fake-mini"
    assert result.confidence == pytest.approx(1.0)
    assert result.scores[0].category == "billing"


def test_classify_margin_is_best_minus_runner_up() -> None:
    result = classification.classify("invoice please")
    assert result.margin == pytest.approx(1.0)


def test_ambiguous_text_falls_back_to_unknown() -> None:
    result = classification.classify("totally unrelated gibberish")
    assert result.category == "unknown"
    assert result.confidence < 0.8


def test_embed_returns_vectors() -> None:
    result = classification.embed(["hello"])
    assert result.vectors == [[0.7071, 0.7071]]
