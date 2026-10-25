from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


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
    texts: list[str] = Field(min_length=1, max_length=64)


class EmbedResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    vectors: list[list[float]]
    model_version: str = Field(alias="modelVersion")


class ErrorBody(BaseModel):
    """Typed error shape returned by non-2xx responses."""

    title: str
    detail: str
    code: str
