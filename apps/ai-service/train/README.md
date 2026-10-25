# Trainer (Phase 7)

Training is **out of the serving path**. The ai-service container does not
install these extras and no inference code imports this package (Phase 7 adds a
lint/contract check for that boundary).

## Environment

- Python 3.12+ via `uv` (same lockfile as the ai-service).
- CPU-only is the supported default; LoRA/MLX are host-only experiments.
- Extra dependency group: **scikit-learn** + **numpy** (`uv sync --extra train`).
- Embeddings come from the same config-bound model used at inference
  (`EMBEDDING_MODEL`, default `all-MiniLM-L6-v2`).

## Reproducible run

From a dataset id (recommended — the API export carries `version`, `sha256`, and
per-example `split` labels):

```bash
cd apps/ai-service
uv sync --extra train
uv run python -m train.linear_probe \
  --dataset-id <id> --api-url http://localhost:3000 \
  --out artifacts/linear-probe-v1
```

Or from an export file:

```bash
curl -s localhost:3000/api/v1/datasets/<id>/export > /tmp/dataset-v1-export.json
uv run python -m train.linear_probe --dataset /tmp/dataset-v1-export.json \
  --out artifacts/linear-probe-v1
```

Outputs in `--out`:

- `model.json` — portable artifact (`coef`/`intercept`/`classes`); reference it
  as `artifactRef` when registering (`component=classifier`,
  `config={"kind":"linear-probe"}`).
- `report.json` — dataset/code/config hashes, held-out metrics, and the frozen
  similarity baseline comparison (`deltaMacroF1`, `beatsBaseline`).
- `eval-report.json` — merged eval-report format; ingest it with
  `POST /api/v1/models/eval-reports`.

Register (and optionally promote) in one command when the API is reachable:

```bash
uv run python -m train.linear_probe \
  --dataset-id <id> --out artifacts/linear-probe-v1 \
  --register --promote
```

Promotion still goes through the registry gates: the report must pass and must
not regress the active baseline (false auto-routing always blocks). The
ai-service reads the artifact from the shared `triageai-artifacts` volume
(`ARTIFACTS_DIR`), so no inference restart is needed.

The optional compose profile runs the same command:

```bash
docker compose --profile core --profile train run --rm trainer \
  train.linear_probe --dataset-id <id> --out /artifacts/linear-probe-v1
```

## What this intentionally does not do

- No automatic training/promotion from decision records: only approved
  `candidate_examples` reach a dataset (FR-6.2/FR-6.3).
- No serving imports (enforced by `tests/test_trainer_boundary.py`), no hosted
  APIs, no GPU assumptions.
- No hidden baseline skip: the frozen similarity baseline is computed on the
  same held-out rows unless `--no-baseline` is explicit.
