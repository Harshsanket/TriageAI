"""HTTP surface tests (model mocked) + optional real-model integration."""

import os

import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def fake_model(request, monkeypatch):
    if request.node.get_closest_marker("real_model"):
        yield
        return
    monkeypatch.setattr(
        routes.classification,
        "classify",
        lambda text, model=None: routes.classification.ClassifyResponse(
            category="billing",
            confidence=0.91,
            margin=0.3,
            method="zero-shot",
            model_version="fake-mini",
            scores=[{"category": "billing", "score": 0.91}, {"category": "security", "score": 0.61}],
        ),
    )
    monkeypatch.setattr(
        routes.classification,
        "embed",
        lambda texts: routes.classification.EmbedResponse(vectors=[[1.0, 0.0]] * len(texts), model_version="fake-mini"),
    )
    yield


def test_health_reports_service() -> None:
    response = client.get("/ai/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_classify_returns_contract_shape() -> None:
    response = client.post("/ai/v1/classify", json={"text": "I was charged twice"})
    assert response.status_code == 200
    body = response.json()
    assert body["category"] == "billing"
    assert body["method"] == "zero-shot"
    assert body["modelVersion"] == "fake-mini"
    assert {score["category"] for score in body["scores"]} == {"billing", "security"}


def test_classify_forwards_registry_model_descriptor(monkeypatch) -> None:
    seen: dict[str, object] = {}

    def fake(text, model=None):
        seen["model"] = model
        return routes.classification.ClassifyResponse(
            category="billing",
            confidence=0.91,
            margin=0.3,
            method="trained",
            model_version="probe-v1",
            scores=[{"category": "billing", "score": 0.91}],
        )

    monkeypatch.setattr(routes.classification, "classify", fake)
    response = client.post(
        "/ai/v1/classify",
        json={
            "text": "I was charged twice",
            "model": {"name": "probe-v1", "artifactRef": "probe-v1", "kind": "linear-probe"},
        },
    )
    assert response.status_code == 200
    assert response.json()["method"] == "trained"
    model = seen["model"]
    assert getattr(model, "kind") == "linear-probe"
    assert getattr(model, "artifact_ref") == "probe-v1"


def test_classify_rejects_empty_text() -> None:
    response = client.post("/ai/v1/classify", json={"text": ""})
    assert response.status_code == 422


def test_embed_returns_one_vector_per_text() -> None:
    response = client.post("/ai/v1/embed", json={"texts": ["a", "b"]})
    assert response.status_code == 200
    body = response.json()
    assert len(body["vectors"]) == 2
    assert body["modelVersion"] == "fake-mini"


def test_modules_lists_embedding_model() -> None:
    response = client.get("/ai/v1/modules")
    assert response.status_code == 200
    assert "embedding_model" in response.json()


@pytest.mark.real_model
@pytest.mark.skipif(os.environ.get("RUN_MODEL_TESTS") != "1", reason="set RUN_MODEL_TESTS=1 to load the real model")
def test_real_model_embedding_and_classification() -> None:
    from app.modules import embeddings

    vectors = embeddings.embed_texts(["hello world"])
    assert len(vectors[0]) == 384
    assert abs(sum(value * value for value in vectors[0]) - 1.0) < 1e-3

    response = client.post("/ai/v1/classify", json={"text": "My card was charged twice this month"})
    assert response.status_code == 200
    assert response.json()["modelVersion"] == "all-MiniLM-L6-v2"
