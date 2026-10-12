from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.routes import router


def create_app() -> FastAPI:
    app = FastAPI(
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

    app.include_router(router)
    return app


app = create_app()
