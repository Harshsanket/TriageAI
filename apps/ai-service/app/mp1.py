"""Minimal MP1 client/helpers for Python provider modules (ADR-0055 §7).

The v1 surface covers what providers need: handshake, health,
capability.serve, event.deliver, drain and stop. Full signature verification
ships with the Python SDK; this module validates the envelope shape and
deadline so a provider fails closed on malformed traffic.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

MP1_OPS = Literal[
    "handshake",
    "health",
    "drain",
    "stop",
    "stage.invoke",
    "route.handle",
    "event.publish",
    "event.deliver",
    "capability.call",
    "capability.serve",
    "task.create",
    "task.update",
    "task.get",
    "runs.get",
    "runs.list",
    "knowledge.query",
    "progress.report",
    "audit.append",
    "log",
]


class Mp1Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mp: Literal["1.0"] = "1.0"
    id: str = Field(min_length=1, max_length=64)
    kind: Literal["request", "response", "event", "stream", "cancel"]
    op: MP1_OPS
    from_: str = Field(alias="from", pattern=r"^(core|module:|agent:|external:)")
    to: str = Field(pattern=r"^(core|capability:|event:|task:|module:)")
    schema_: str = Field(alias="schema", pattern=r"^[a-z][a-z0-9.-]*@\d+$")
    correlationId: str | None = None
    runId: str | None = None
    idempotencyKey: str | None = None
    deadline: str
    dataClass: Literal["public", "internal", "restricted", "secret"] = "internal"
    payload: Any = None
    coreSig: str | None = None

    def expired(self, now: datetime | None = None) -> bool:
        moment = now or datetime.now(timezone.utc)
        deadline = datetime.fromisoformat(self.deadline.replace("Z", "+00:00"))
        return deadline < moment


def parse_envelope(raw: dict[str, Any]) -> Mp1Envelope:
    """Validate an MP1 envelope; raises pydantic.ValidationError on bad input."""
    envelope = Mp1Envelope.model_validate(raw)
    if envelope.expired():
        raise ValueError("MP1_DEADLINE_EXPIRED")
    return envelope


def response_for(
    request: Mp1Envelope,
    *,
    module_id: str,
    version: str,
    payload: Any,
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "mp": "1.0",
        "id": f"res-{request.id}",
        "kind": "response",
        "op": request.op,
        "from": f"module:{module_id}@{version}",
        "to": request.from_,
        "schema": "mp1.response@1",
        "correlationId": request.id,
        "deadline": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "dataClass": request.dataClass,
        "payload": None if error else payload,
        **({"error": error} if error else {}),
    }
