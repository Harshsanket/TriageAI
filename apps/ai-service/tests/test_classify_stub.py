from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_classify_returns_501_until_phase_1() -> None:
    response = client.post("/ai/v1/classify", json={"text": "I cannot upload a PDF larger than 25MB"})
    assert response.status_code == 501
    body = response.json()
    assert body["detail"]["code"] == "NOT_IMPLEMENTED"


def test_classify_rejects_empty_text() -> None:
    response = client.post("/ai/v1/classify", json={"text": ""})
    assert response.status_code == 422


def test_embed_returns_501_until_phase_1() -> None:
    response = client.post("/ai/v1/embed", json={"texts": ["hello"]})
    assert response.status_code == 501
