# ai-service image: Python 3.13 + uv (apps/ai-service), CPU torch.
# Model artifacts are downloaded at runtime into a named volume
# (`triageai-hf-cache`, mounted at $HF_HOME) — see ADR-0008.
FROM python:3.13-slim AS runtime

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/ai-service/pyproject.toml apps/ai-service/uv.lock ./

RUN uv sync --no-dev --frozen

COPY apps/ai-service/ ./app/

ENV HF_HOME=/models
VOLUME ["/models"]

EXPOSE 8000

ENTRYPOINT ["dumb-init", "--"]
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
