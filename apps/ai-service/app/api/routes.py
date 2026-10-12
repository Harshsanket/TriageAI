from fastapi import APIRouter, HTTPException

from app.api.schemas import ClassifyRequest, ClassifyResponse, EmbedRequest, EmbedResponse, HealthResponse
from app.modules import classification, generation, retrieval

router = APIRouter(prefix="/ai/v1")

SERVICE_VERSION = "0.0.1"


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(version=SERVICE_VERSION)


@router.post("/classify", response_model=ClassifyResponse)
async def classify(request: ClassifyRequest) -> ClassifyResponse:
    """
    Stage 1 (Phase 1): similarity-based classification with pretrained
    SentenceTransformers embeddings — never a generative LLM call.
    """
    try:
        return classification.classify(request.text)
    except NotImplementedError:
        raise HTTPException(
            status_code=501,
            detail={"code": "NOT_IMPLEMENTED", "title": "NOT_IMPLEMENTED", "detail": "classify() pending Phase 1"},
        ) from None


@router.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest) -> EmbedResponse:
    try:
        return classification.embed(request.texts)
    except NotImplementedError:
        raise HTTPException(
            status_code=501,
            detail={"code": "NOT_IMPLEMENTED", "title": "NOT_IMPLEMENTED", "detail": "embed() pending Phase 1"},
        ) from None


@router.get("/modules")
async def modules() -> dict[str, str]:
    """Phase 0 introspection: proves the three AI modules are separate and loadable."""
    return {
        "classification": classification.describe(),
        "retrieval": retrieval.describe(),
        "generation": generation.describe(),
    }
