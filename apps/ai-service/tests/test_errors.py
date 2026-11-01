import json

from fastapi.testclient import TestClient

from app.api.schemas import ErrorEnvelope
from app.main import app, create_app

client = TestClient(app)


def test_validation_errors_use_the_shared_envelope() -> None:
    response = client.post("/ai/v1/classify", json={"text": ""})
    assert response.status_code == 422
    body = ErrorEnvelope.model_validate(response.json())
    assert body.status == 422
    assert body.code == "VALIDATION_ERROR"
    assert body.category == "validation"
    assert body.retryable is False
    assert body.correlation_id
    assert body.user_message
    assert "retryAfterMs" not in response.json()


def test_unknown_routes_use_the_shared_envelope() -> None:
    response = client.get("/ai/v1/does-not-exist")
    assert response.status_code == 404
    body = ErrorEnvelope.model_validate(response.json())
    assert body.code == "NOT_FOUND"
    assert body.category == "not_found"
    assert body.retryable is False


def test_model_failures_are_retryable_dependency_errors(monkeypatch) -> None:
    from app.api import routes

    def boom(*_args, **_kwargs):
        raise RuntimeError("model not loaded")

    monkeypatch.setattr(routes.classification, "classify", boom)
    response = client.post("/ai/v1/classify", json={"text": "hello"})
    assert response.status_code == 503
    body = ErrorEnvelope.model_validate(response.json())
    assert body.code == "DEPENDENCY_UNAVAILABLE"
    assert body.category == "dependency_unavailable"
    assert body.retryable is True
    assert body.detail is not None and "model not loaded" in body.detail
    assert "model not loaded" not in body.user_message


def test_unhandled_errors_are_internal_without_detail() -> None:
    failing_app = create_app()

    @failing_app.get("/__boom")
    async def boom() -> None:
        raise RuntimeError("SQLSTATE 42P01 at /secret")

    with TestClient(failing_app, raise_server_exceptions=False) as failing_client:
        response = failing_client.get("/__boom", headers={"x-request-id": "req-1"})

    assert response.status_code == 500
    payload = response.json()
    body = ErrorEnvelope.model_validate(payload)
    assert body.code == "INTERNAL_ERROR"
    assert body.category == "internal"
    assert body.retryable is False
    assert body.correlation_id == "req-1"
    assert "detail" not in payload
    assert "SQLSTATE" not in json.dumps(payload)
    assert "/secret" not in json.dumps(payload)
