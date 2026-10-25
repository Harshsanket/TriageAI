# Trainer image (Phase 7, optional `train` profile).
#
# Deliberately separate from the inference image: it installs the `train` extra
# (scikit-learn/numpy) and never becomes a serving dependency. It writes model
# artifacts to the shared `triageai-artifacts` volume that the ai-service reads
# through the model registry.
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/ai-service/pyproject.toml apps/ai-service/uv.lock ./
RUN uv sync --no-dev --frozen --extra train

COPY apps/ai-service/ ./

ENV HF_HOME=/models
ENV ARTIFACTS_DIR=/artifacts
VOLUME ["/models", "/artifacts"]

ENTRYPOINT ["dumb-init", "--", "uv", "run", "python", "-m"]
CMD ["train.linear_probe", "--help"]
