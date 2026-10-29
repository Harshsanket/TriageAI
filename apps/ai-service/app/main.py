import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
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
            classification.preload()
            logger.info("classifier backend ready")
        except Exception:  # noqa: BLE001 - readiness must reflect real failures
            logger.exception("failed to preload embedding model")
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        lifespan=lifespan,
        title="TriageAI AI Service",
        version="0.0.1",
        description=(
            "Local-only ML inference: embeddings and ticket classification. "
            "Retrieval and generation run in the API host. No hosted APIs."
        ),
    )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "ai-service"}

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        try:
            classification.preload()
        except Exception as exc:  # noqa: BLE001
            return JSONResponse(status_code=503, content={"status": "not_ready", "detail": str(exc)})
        return JSONResponse(content={"status": "ready", "model": embeddings.model_version()})

    app.include_router(router)
    return app


app = create_app()
