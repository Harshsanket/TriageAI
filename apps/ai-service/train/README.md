# Trainer prerequisites (Phase 6 seed)

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

```bash
cd apps/ai-service
uv sync --extra train
uv run python -m train.linear_probe \
  --dataset /tmp/dataset-v1-export.json \
  --out artifacts/linear-probe-v1
```

Get the export from a versioned dataset (approved examples only):

```bash
curl -s localhost:3000/api/v1/datasets/<id>/export > /tmp/dataset-v1-export.json
```

The export carries `version`, `sha256`, and per-example `split`
(`train`/`val`/`test`) labels. `report.json` records the dataset sha, git code
sha, config hash, Python version, and **held-out** test accuracy; `model.json`
is the artifact to register in the model registry (`component=classifier`,
`artifactRef=<path>`).

## What this intentionally does not do

- No automatic promotion: a human must attach a passing eval report and call
  `POST /api/v1/models/:id/promote`.
- No training on decision records: only approved `candidate_examples` reach a
  dataset (FR-6.2/FR-6.3).
- No serving imports, no network calls, no GPU assumptions.
