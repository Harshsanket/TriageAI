from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.mp1 import parse_envelope, response_for


def envelope(**overrides):
    values = {
        "mp": "1.0",
        "id": "req-1",
        "kind": "request",
        "op": "health",
        "from": "core",
        "to": "module:embedder@1.0.0",
        "schema": "mp1.health@1",
        "deadline": (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat(),
        "dataClass": "internal",
        "payload": {},
    }
    values.update(overrides)
    return values


def test_parses_valid_envelope():
    parsed = parse_envelope(envelope())
    assert parsed.from_ == "core"
    assert parsed.schema_ == "mp1.health@1"


def test_rejects_unknown_keys_and_expired_deadline():
    with pytest.raises(ValidationError):
        parse_envelope({**envelope(), "extra": True})
    with pytest.raises(ValueError, match="MP1_DEADLINE_EXPIRED"):
        parse_envelope(
            envelope(
                deadline=(datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
            )
        )


def test_builds_a_response():
    request = parse_envelope(envelope())
    response = response_for(request, module_id="embedder", version="1.0.0", payload={"ok": True})
    assert response["correlationId"] == request.id
    assert response["from"] == "module:embedder@1.0.0"
    assert response["payload"] == {"ok": True}


def test_provider_handshake_endpoint():
    from fastapi.testclient import TestClient

    from app.main import create_app

    client = TestClient(create_app())
    response = client.post("/mp1/embedder", json=envelope(to="module:embedder@1.0.0", op="handshake", schema="mp1.handshake@1", payload={"mp": "1.0", "moduleId": "embedder", "version": "0.0.1", "schemas": [], "runMode": "container"}))
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "response"
    assert body["correlationId"] == "req-1"
    assert body["from"] == "module:embedder@0.0.1"
