import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.config import settings
from app.modules import classification, embeddings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Warm the embedding model so the first classification meets its latency budget."""
    if settings.preload_model:
        try:
            embeddings.get_model()
            classification.exemplar_vectors()
            logger.info("embedding model + exemplar vectors ready")
        except Exception:  # noqa: BLE001 - readiness must reflect real failures
            logger.exception("failed to preload embedding model")
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        lifespan=lifespan,
        title="TriageAI AI Service",
        version="0.0.1",
        description=(
            "Local-only ML inference: ticket classification, retrieval support, "
            "and pluggable local generation adapters (MLX / LM Studio / Ollama). "
            "No hosted LLM APIs."
        ),
    )

    @app.exception_handler(NotImplementedError)
    async def not_implemented_handler(request: Request, exc: NotImplementedError) -> JSONResponse:
        return JSONResponse(
            status_code=501,
            content={
                "code": "NOT_IMPLEMENTED",
                "title": "NOT_IMPLEMENTED",
                "detail": str(exc) or "Not implemented yet",
                "path": request.url.path,
            },
        )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "ai-service"}

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        try:
            embeddings.get_model()
            classification.exemplar_vectors()
        except Exception as exc:  # noqa: BLE001
            return JSONResponse(status_code=503, content={"status": "not_ready", "detail": str(exc)})
        return JSONResponse(content={"status": "ready", "model": embeddings.model_version()})

    app.include_router(router)
    return app


app = create_app()
