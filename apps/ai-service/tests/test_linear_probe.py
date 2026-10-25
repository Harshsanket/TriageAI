"""Trained classifier backend + metrics (Phase 7), no model download required."""

import json

import pytest

from app.modules import linear_probe
from train import linear_probe as trainer


@pytest.fixture()
def artifact_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(linear_probe.settings, "artifacts_dir", str(tmp_path))
    probe = tmp_path / "probe-v1"
    probe.mkdir()
    (probe / "model.json").write_text(
        json.dumps(
            {
                "kind": "linear-probe",
                "modelVersion": "probe-v1-test",
                "embeddingModel": "fake-mini",
                "classes": ["billing", "security"],
                "coef": [[1.0, 0.0], [0.0, 1.0]],
                "intercept": [0.0, 0.0],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        linear_probe.embeddings,
        "embed_texts",
        lambda texts: [
            [1.0, 0.0]
            if text == "invoice"
            else [0.0, 1.0]
            if text == "hacked"
            else [0.7071, 0.7071]
            for text in texts
        ],
    )
    linear_probe.reset_cache()
    yield tmp_path
    linear_probe.reset_cache()


def test_trained_classifier_returns_scores_and_method(artifact_dir) -> None:
    result = linear_probe.classify("invoice", "probe-v1")
    assert result.category == "billing"
    assert result.method == "trained"
    assert result.model_version == "probe-v1-test"
    assert result.confidence > 0.7
    assert {score.category for score in result.scores} == {"billing", "security"}


def test_trained_low_margin_falls_back_to_unknown(artifact_dir) -> None:
    result = linear_probe.classify("unclear", "probe-v1")
    assert result.category == "unknown"
    assert result.margin < linear_probe.settings.classifier_margin


def test_artifact_paths_are_confined_to_the_artifacts_root(artifact_dir) -> None:
    with pytest.raises(linear_probe.ModelArtifactError):
        linear_probe.resolve_artifact("../../etc/passwd")
    with pytest.raises(linear_probe.ModelArtifactError):
        linear_probe.load_artifact("missing")


def test_dimension_mismatch_is_typed(artifact_dir) -> None:
    (artifact_dir / "bad").mkdir()
    (artifact_dir / "bad" / "model.json").write_text(
        json.dumps(
            {
                "kind": "linear-probe",
                "classes": ["billing"],
                "coef": [[1.0, 0.0, 0.0]],
                "intercept": [0.0],
            }
        ),
        encoding="utf-8",
    )
    linear_probe.reset_cache()
    with pytest.raises(linear_probe.ModelArtifactError):
        linear_probe.classify("invoice", "bad")


def test_classification_metrics_flag_false_auto_routing() -> None:
    metrics = trainer.classification_metrics(
        [
            {"expected": "security", "predicted": "billing", "latencyMs": 10},
            {"expected": "billing", "predicted": "billing", "latencyMs": 20},
            {"expected": "security", "predicted": "unknown", "latencyMs": 30},
        ],
        ("security",),
    )
    assert metrics["falseAutoRoutingCount"] == 1
    assert metrics["macroF1"] < 1
    assert metrics["p95LatencyMs"] == 30


def test_dataset_text_and_labels_are_normalized() -> None:
    assert trainer.text_of({"subject": "Hi", "body": "There"}) == "Hi\n\nThere"
    assert trainer.text_of({"text": "just text"}) == "just text"
    assert trainer.label_of({"category": "billing"}) == "billing"
    assert trainer.label_of({"priorityCode": "P1"}) == "unknown"
