from fastapi import APIRouter, HTTPException

from app.api.schemas import ClassifyRequest, ClassifyResponse, EmbedRequest, EmbedResponse, HealthResponse
from app.modules import classification, embeddings, generation, retrieval

router = APIRouter(prefix="/ai/v1")

SERVICE_VERSION = "0.0.1"


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(version=SERVICE_VERSION)


@router.post("/classify", response_model=ClassifyResponse)
async def classify(request: ClassifyRequest) -> ClassifyResponse:
    """Embedding-similarity classification. Never a generative LLM call."""
    try:
        return classification.classify(request.text, request.model)
    except Exception as exc:  # noqa: BLE001 - surfaced as a typed 503, never a stack trace
        raise HTTPException(
            status_code=503,
            detail={"code": "MODEL_UNAVAILABLE", "title": "MODEL_UNAVAILABLE", "detail": str(exc)},
        ) from None


@router.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest) -> EmbedResponse:
    try:
        return classification.embed(request.texts)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=503,
            detail={"code": "MODEL_UNAVAILABLE", "title": "MODEL_UNAVAILABLE", "detail": str(exc)},
        ) from None


@router.get("/modules")
async def modules() -> dict[str, str]:
    """Introspection: proves the three AI modules are separate and loadable."""
    return {
        "classification": classification.describe(),
        "embedding_model": embeddings.model_version(),
        "retrieval": retrieval.describe(),
        "generation": generation.describe(),
    }
