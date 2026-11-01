import json
import logging
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.mp1_routes import router as mp1_router
from app.api.routes import router
from app.api.schemas import ErrorCategory, ErrorEnvelope
from app.core.config import settings
from app.modules import classification, embeddings

logger = logging.getLogger(__name__)

GENERIC_USER_MESSAGE = "Something went wrong. Try again or check the server logs."


def _correlation_id(request: Request) -> str:
    return (
        request.headers.get("x-request-id")
        or request.headers.get("x-correlation-id")
        or uuid4().hex
    )


def _taxonomy(status: int) -> tuple[ErrorCategory, bool]:
    if status in (400, 422):
        return "validation", False
    if status == 401:
        return "unauthenticated", False
    if status == 403:
        return "forbidden", False
    if status == 404:
        return "not_found", False
    if status == 409:
        return "conflict", False
    if status == 408 or status == 504:
        return "timeout", True
    if status == 429:
        return "rate_limited", True
    if status in (502, 503, 529):
        return "dependency_unavailable", True
    return "internal", False


def _code_for_status(status: int) -> str:
    return {
        400: "VALIDATION_ERROR",
        422: "VALIDATION_ERROR",
        401: "UNAUTHENTICATED",
        403: "FORBIDDEN",
        404: "NOT_FOUND",
        409: "CONFLICT",
        429: "RATE_LIMITED",
        408: "TIMEOUT",
        504: "TIMEOUT",
        502: "DEPENDENCY_UNAVAILABLE",
        503: "DEPENDENCY_UNAVAILABLE",
        529: "DEPENDENCY_UNAVAILABLE",
        500: "INTERNAL_ERROR",
    }.get(status, f"HTTP_{status}")


def _detail_text(detail: object) -> str | None:
    if detail is None:
        return None
    if isinstance(detail, str):
        return detail
    return json.dumps(detail, ensure_ascii=False)


def _error_response(
    request: Request,
    *,
    status: int,
    code: str | None = None,
    category: ErrorCategory | None = None,
    retryable: bool | None = None,
    user_message: str | None = None,
    detail: str | None = None,
    retry_after_ms: int | None = None,
) -> JSONResponse:
    inferred_category, inferred_retryable = _taxonomy(status)
    resolved_category = category or inferred_category
    resolved_retryable = inferred_retryable if retryable is None else retryable
    if user_message is None:
        if resolved_category == "dependency_unavailable":
            user_message = "A required service is temporarily unavailable. Try again shortly."
        elif status >= 500:
            user_message = GENERIC_USER_MESSAGE
        else:
            user_message = detail or "The request failed."
    envelope = ErrorEnvelope(
        type=f"https://triageai.dev/errors/{code or _code_for_status(status)}",
        title=code or _code_for_status(status),
        status=status,
        code=code or _code_for_status(status),
        category=resolved_category,
        retryable=resolved_retryable,
        retryAfterMs=retry_after_ms,
        userMessage=user_message,
        detail=detail,
        correlationId=_correlation_id(request),
    )
    return JSONResponse(
        status_code=status,
        content=envelope.model_dump(by_alias=True, exclude_none=True),
    )


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

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return _error_response(
            request,
            status=422,
            code="VALIDATION_ERROR",
            category="validation",
            retryable=False,
            user_message="The request is invalid.",
            detail=str(exc),
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return _error_response(
            request,
            status=exc.status_code,
            code=_code_for_status(exc.status_code),
            detail=_detail_text(exc.detail),
        )

    @app.exception_handler(Exception)
    async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled ai-service error", exc_info=exc)
        return _error_response(
            request,
            status=500,
            code="INTERNAL_ERROR",
            category="internal",
            retryable=False,
        )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "ai-service"}

    @app.get("/readyz")
    async def readyz(request: Request) -> JSONResponse:
        try:
            classification.preload()
        except Exception as exc:  # noqa: BLE001
            logger.exception("ai-service is not ready")
            return _error_response(
                request,
                status=503,
                code="DEPENDENCY_UNAVAILABLE",
                category="dependency_unavailable",
                retryable=True,
                detail=str(exc),
            )
        return JSONResponse(content={"status": "ready", "model": embeddings.model_version()})

    app.include_router(router)
    app.include_router(mp1_router)
    return app


app = create_app()
