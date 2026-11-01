from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class HardwareResponse(BaseModel):
    """GPU backend visible to torch. Mirrors HardwareProfile.gpu in packages/contracts."""

    kind: Literal["cuda", "mps", "none"]
    name: str | None = None
    memoryBytes: int | None = None


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: Literal["ai-service"] = "ai-service"
    version: str


class ClassifyModel(BaseModel):
    """Active model registry pointer forwarded by the host (Phase 7)."""

    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(min_length=1)
    artifact_ref: str = Field(alias="artifactRef", min_length=1)
    kind: Literal["similarity", "linear-probe"]


class ClassifyRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    model: ClassifyModel | None = None


class CategoryScore(BaseModel):
    category: str
    score: float = Field(ge=0.0, le=1.0)


class ClassifyResponse(BaseModel):
    """Contract consumed by apps/api — camelCase on the wire (Zod is the source of truth)."""

    model_config = ConfigDict(populate_by_name=True)

    category: str
    confidence: float = Field(ge=0.0, le=1.0)
    margin: float = Field(ge=0.0, le=1.0)
    method: Literal["zero-shot", "trained"]
    model_version: str = Field(alias="modelVersion")
    scores: list[CategoryScore]


class EmbedRequest(BaseModel):
    texts: list[Annotated[str, Field(max_length=20_000)]] = Field(min_length=1, max_length=64)


class EmbedResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    vectors: list[list[float]]
    model_version: str = Field(alias="modelVersion")


ErrorCategory = Literal[
    "validation",
    "unauthenticated",
    "forbidden",
    "not_found",
    "conflict",
    "rate_limited",
    "dependency_unavailable",
    "timeout",
    "budget_exceeded",
    "policy_blocked",
    "internal",
]


class ErrorEnvelope(BaseModel):
    """The shared error contract (packages/contracts/src/errors.ts)."""

    model_config = ConfigDict(populate_by_name=True)

    type: str
    title: str
    status: int = Field(ge=400, le=599)
    code: str
    category: ErrorCategory
    retryable: bool
    retry_after_ms: int | None = Field(default=None, alias="retryAfterMs", ge=0)
    user_message: str = Field(alias="userMessage", min_length=1)
    detail: str | None = None
    correlation_id: str = Field(alias="correlationId", min_length=1)
