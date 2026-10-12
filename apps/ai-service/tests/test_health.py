from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz() -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "ai-service"}


def test_versioned_health() -> None:
    response = client.get("/ai/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "ai-service"


def test_modules_are_separate_and_describable() -> None:
    response = client.get("/ai/v1/modules")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"classification", "retrieval", "generation"}
    assert all(isinstance(v, str) and v for v in body.values())
