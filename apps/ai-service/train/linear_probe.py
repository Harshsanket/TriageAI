"""Minimal linear-probe classifier seed (Phase 6 prerequisite; Phase 7 materializes).

Trains a logistic regression on frozen MiniLM embeddings from an exported,
versioned dataset. Training is deliberately separate from inference: nothing in
the serving path imports this module.

    uv sync --extra train
    uv run python -m train.linear_probe \
        --dataset /tmp/dataset-export.json \
        --out artifacts/linear-probe

The export comes from `GET /api/v1/datasets/:id/export` and carries the dataset
sha256 plus per-example `split` labels. The report records dataset/code/config
hashes so a run is reproducible.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any


def label_of(gold: Any) -> str:
    if isinstance(gold, dict):
        for key in ("category", "label"):
            value = gold.get(key)
            if isinstance(value, str) and value:
                return value
    return "unknown"


def text_of(payload: Any) -> str:
    if isinstance(payload, dict):
        subject = payload.get("subject")
        body = payload.get("body") or payload.get("text")
        if isinstance(subject, str) and isinstance(body, str):
            return f"{subject}\n\n{body}".strip()
        if isinstance(body, str):
            return body
    return json.dumps(payload, sort_keys=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def code_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parents[3], text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="dataset export JSON")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--embedding-model", default=os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2"))
    parser.add_argument("--seed", type=int, default=17)
    args = parser.parse_args()

    try:
        import numpy as np
        from sklearn.linear_model import LogisticRegression
        from sentence_transformers import SentenceTransformer
    except ImportError as err:  # pragma: no cover - documented prerequisite
        print(
            f"missing training dependency: {err}\n"
            "Run `uv sync --extra train` in apps/ai-service (CPU-only).",
            file=sys.stderr,
        )
        return 2

    dataset_path = Path(args.dataset)
    export = json.loads(dataset_path.read_text(encoding="utf-8"))
    examples = export.get("examples") or []
    if not examples:
        print("dataset export has no examples", file=sys.stderr)
        return 1

    train = [item for item in examples if item.get("split") != "test"]
    test = [item for item in examples if item.get("split") == "test"]
    if not train:
        train, test = examples, []

    encoder = SentenceTransformer(args.embedding_model, device="cpu")
    train_texts = [text_of(item.get("input")) for item in train]
    train_labels = [label_of(item.get("gold")) for item in train]
    embeddings = encoder.encode(train_texts, normalize_embeddings=True, show_progress_bar=False)

    classifier = LogisticRegression(max_iter=1000, class_weight="balanced", random_state=args.seed)
    classifier.fit(np.asarray(embeddings), train_labels)

    metrics: dict[str, Any] = {
        "trainExamples": len(train),
        "testExamples": len(test),
        "classes": sorted(set(train_labels)),
        "trainAccuracy": round(float(classifier.score(np.asarray(embeddings), train_labels)), 4),
    }
    if test:
        test_embeddings = encoder.encode(
            [text_of(item.get("input")) for item in test],
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        test_labels = [label_of(item.get("gold")) for item in test]
        metrics["testAccuracy"] = round(
            float(classifier.score(np.asarray(test_embeddings), test_labels)), 4
        )

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    artifact = {
        "kind": "linear-probe",
        "embeddingModel": args.embedding_model,
        "classes": list(classifier.classes_),
        "coef": classifier.coef_.tolist(),
        "intercept": classifier.intercept_.tolist(),
        "seed": args.seed,
        "datasetSha256": export.get("sha256") or sha256_file(dataset_path),
    }
    (out_dir / "model.json").write_text(json.dumps(artifact, indent=2), encoding="utf-8")

    report = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "kind": "linear-probe-training",
        "embeddingModel": args.embedding_model,
        "datasetSha256": artifact["datasetSha256"],
        "datasetVersion": export.get("version"),
        "codeSha": code_sha(),
        "configHash": hashlib.sha256(
            json.dumps({"seed": args.seed, "model": args.embedding_model}, sort_keys=True).encode()
        ).hexdigest(),
        "python": platform.python_version(),
        "metrics": metrics,
        "note": "testAccuracy is held-out; trainAccuracy is not an eval metric",
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
