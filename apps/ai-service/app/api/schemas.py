from typing import Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: Literal["ai-service"] = "ai-service"
    version: str


class ClassifyRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)


class CategoryScore(BaseModel):
    category: str
    score: float = Field(ge=0.0, le=1.0)


class ClassifyResponse(BaseModel):
    """Contract consumed by apps/api — keep in sync with docs/ARCHITECTURE.md §7."""

    category: str
    confidence: float = Field(ge=0.0, le=1.0)
    margin: float = Field(ge=0.0, le=1.0)
    method: Literal["zero-shot", "trained"]
    model_version: str
    scores: list[CategoryScore]


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    model_version: str


class ErrorBody(BaseModel):
    """Typed error shape returned by non-2xx responses."""

    title: str
    detail: str
    code: str
