"""Linear-probe classifier training (Phase 7).

Trains a logistic regression on frozen MiniLM embeddings from a versioned,
exported dataset. Training is deliberately separate from inference: nothing in
the serving path imports this module (enforced by a boundary test).

    # from a dataset id (recommended: the export carries splits + sha256)
    uv sync --extra train
    uv run python -m train.linear_probe \
        --dataset-id 01J... --api-url http://localhost:3000 \
        --out artifacts/linear-probe-v1 --register

The artifact (`model.json`) is a portable JSON document; the ai-service loads it
when the registry marks it active. `report.json` records dataset/code/config
hashes and an expanded eval report in the merged format (`eval-report.json`).

Ship-the-baseline rule: the trainer always reports the frozen similarity
baseline on the held-out split. A trained model is promoted only through the
registry, and only if its report beats the active baseline (ADR-0017).
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
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EXEMPLARS_PATH = ROOT / "app" / "data" / "exemplars.json"
DEFAULT_SAFETY_CATEGORIES = ("security",)
GATES = {"macroF1": 0.70, "p95LatencyMs": 500.0, "falseAutoRoutingCount": 0.0}


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
            ["git", "rev-parse", "HEAD"], cwd=ROOT.parents[1], text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def p95(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round(0.95 * (len(ordered) - 1))))
    return ordered[index]


def classification_metrics(
    rows: list[dict[str, Any]],
    safety_categories: tuple[str, ...] = DEFAULT_SAFETY_CATEGORIES,
) -> dict[str, Any]:
    """Pure metrics for a list of {expected, predicted, latencyMs} rows."""
    labels = sorted({row["expected"] for row in rows} | {row["predicted"] for row in rows})
    confusion: dict[str, dict[str, int]] = {label: {} for label in labels}
    for row in rows:
        bucket = confusion.setdefault(row["expected"], {})
        bucket[row["predicted"]] = bucket.get(row["predicted"], 0) + 1

    per_category: dict[str, dict[str, float]] = {}
    f1_scores: list[float] = []
    for label in labels:
        tp = confusion.get(label, {}).get(label, 0)
        fp = sum(
            confusion.get(other, {}).get(label, 0) for other in labels if other != label
        )
        fn = sum(
            count
            for predicted, count in confusion.get(label, {}).items()
            if predicted != label
        )
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_category[label] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "support": sum(confusion.get(label, {}).values()),
        }
        f1_scores.append(f1)

    false_auto = [
        row
        for row in rows
        if row["expected"] in safety_categories and row["predicted"] not in (row["expected"], "unknown")
    ]
    return {
        "macroF1": round(sum(f1_scores) / len(f1_scores), 4) if f1_scores else 0.0,
        "p95LatencyMs": round(p95([float(row.get("latencyMs", 0)) for row in rows]), 2),
        "falseAutoRoutingCount": len(false_auto),
        "falseAutoRoutingExamples": false_auto,
        "perCategory": per_category,
        "confusionMatrix": confusion,
        "examples": len(rows),
    }


def fetch_export(api_url: str, dataset_id: str) -> dict[str, Any]:
    url = f"{api_url.rstrip('/')}/api/v1/datasets/{dataset_id}/export"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 - local API
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as err:
        raise SystemExit(f"could not fetch dataset export from {url}: {err}") from None


def post_json(api_url: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{api_url.rstrip('/')}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - local API
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise SystemExit(f"{path} failed ({err.code}): {detail}") from None


def similarity_baseline(
    texts: list[str], labels: list[str], encoder: Any, threshold: float, margin: float
) -> list[str]:
    """Frozen similarity baseline (same idea as the serving zero-shot path)."""
    import numpy as np

    exemplars = json.loads(EXEMPLARS_PATH.read_text(encoding="utf-8"))
    categories = sorted(exemplars)
    vectors = {
        category: encoder.encode(
            exemplars[category], normalize_embeddings=True, show_progress_bar=False
        )
        for category in categories
    }
    text_vectors = encoder.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    predicted: list[str] = []
    for index, vector in enumerate(np.asarray(text_vectors)):
        scores = sorted(
            (
                (float(np.max(np.asarray(vectors[category]) @ vector)), category)
                for category in categories
            ),
            reverse=True,
        )
        best_score, best_category = scores[0]
        runner = scores[1][0] if len(scores) > 1 else 0.0
        if best_score < threshold or best_score - runner < margin:
            predicted.append("unknown")
        else:
            predicted.append(best_category)
        _ = labels[index]  # labels are not needed for zero-shot prediction
    return predicted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--dataset", help="dataset export JSON file")
    source.add_argument("--dataset-id", help="fetch the export for this dataset id")
    parser.add_argument("--api-url", default=os.environ.get("TRIAGEAI_API_URL", "http://localhost:3000"))
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--name", help="registry asset name (defaults to the model version)")
    parser.add_argument("--artifact-ref", help="registry artifactRef (defaults to the out directory name)")
    parser.add_argument("--embedding-model", default=os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2"))
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--threshold", type=float, default=0.35, help="similarity baseline threshold")
    parser.add_argument("--margin", type=float, default=0.05, help="similarity baseline margin")
    parser.add_argument(
        "--safety-category",
        action="append",
        dest="safety_categories",
        help="repeatable; false auto-routing on these blocks promotion (default: security)",
    )
    parser.add_argument("--register", action="store_true", help="register asset + eval report")
    parser.add_argument("--promote", action="store_true", help="promote after registering")
    parser.add_argument("--actor", default="trainer", help="registry audit actor")
    parser.add_argument("--no-baseline", action="store_true", help="skip the similarity comparison")
    args = parser.parse_args()
    if args.promote and not args.register:
        parser.error("--promote requires --register")

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

    if args.dataset_id:
        export = fetch_export(args.api_url, args.dataset_id)
        dataset_path = Path(args.out) / "dataset-export.json"
        dataset_path.parent.mkdir(parents=True, exist_ok=True)
        dataset_path.write_text(json.dumps(export, indent=2), encoding="utf-8")
    else:
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
    if not test:
        print("dataset export has no held-out test examples", file=sys.stderr)
        return 1

    encoder = SentenceTransformer(args.embedding_model, device="cpu")
    train_texts = [text_of(item.get("input")) for item in train]
    train_labels = [label_of(item.get("gold")) for item in train]
    embeddings = encoder.encode(train_texts, normalize_embeddings=True, show_progress_bar=False)

    classifier = LogisticRegression(max_iter=1000, class_weight="balanced", random_state=args.seed)
    classifier.fit(np.asarray(embeddings), train_labels)

    test_texts = [text_of(item.get("input")) for item in test]
    test_labels = [label_of(item.get("gold")) for item in test]
    test_embeddings = encoder.encode(test_texts, normalize_embeddings=True, show_progress_bar=False)

    started = time.perf_counter()
    predicted = classifier.predict(np.asarray(test_embeddings)).tolist()
    latency = (time.perf_counter() - started) * 1000 / max(1, len(predicted))
    rows = [
        {"expected": expected, "predicted": str(actual), "latencyMs": latency}
        for expected, actual in zip(test_labels, predicted, strict=True)
    ]
    metrics = classification_metrics(rows, tuple(args.safety_categories or DEFAULT_SAFETY_CATEGORIES))

    baseline_metrics: dict[str, Any] | None = None
    if not args.no_baseline:
        baseline_started = time.perf_counter()
        baseline_predicted = similarity_baseline(
            test_texts, test_labels, encoder, args.threshold, args.margin
        )
        baseline_latency = (time.perf_counter() - baseline_started) * 1000 / max(
            1, len(baseline_predicted)
        )
        baseline_metrics = classification_metrics(
            [
                {"expected": expected, "predicted": actual, "latencyMs": baseline_latency}
                for expected, actual in zip(test_labels, baseline_predicted, strict=True)
            ],
            tuple(args.safety_categories or DEFAULT_SAFETY_CATEGORIES),
        )

    coef = classifier.coef_.tolist()
    intercept = classifier.intercept_.tolist()
    dataset_sha = export.get("sha256") or sha256_file(dataset_path)
    model_digest = hashlib.sha256(
        json.dumps(
            {
                "coef": coef,
                "intercept": intercept,
                "classes": list(classifier.classes_),
                "embeddingModel": args.embedding_model,
                "datasetSha256": dataset_sha,
                "seed": args.seed,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    model_version = f"linear-probe-{export.get('version') or 'adhoc'}-{model_digest[:8]}"
    artifact_ref = args.artifact_ref or Path(args.out).name

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    artifact = {
        "kind": "linear-probe",
        "modelVersion": model_version,
        "embeddingModel": args.embedding_model,
        "classes": list(classifier.classes_),
        "coef": coef,
        "intercept": intercept,
        "seed": args.seed,
        "datasetSha256": dataset_sha,
        "datasetVersion": export.get("version"),
    }
    (out_dir / "model.json").write_text(json.dumps(artifact, indent=2), encoding="utf-8")

    passed = (
        metrics["macroF1"] >= GATES["macroF1"]
        and metrics["p95LatencyMs"] <= GATES["p95LatencyMs"]
        and metrics["falseAutoRoutingCount"] <= GATES["falseAutoRoutingCount"]
    )
    delta = (
        round(metrics["macroF1"] - baseline_metrics["macroF1"], 4)
        if baseline_metrics
        else None
    )
    suite_metrics = {
        "macroF1": metrics["macroF1"],
        "p95LatencyMs": metrics["p95LatencyMs"],
        "falseAutoRoutingCount": metrics["falseAutoRoutingCount"],
        "testExamples": len(test),
        "trainExamples": len(train),
    }
    if baseline_metrics:
        suite_metrics["baselineMacroF1"] = baseline_metrics["macroF1"]
        suite_metrics["deltaMacroF1"] = delta if delta is not None else 0.0
    eval_report = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "subjectModelId": None,
        "baselineModelId": None,
        "suites": [
            {
                "suite": "classification",
                "status": "passed" if passed else "failed",
                "metrics": suite_metrics,
                "gates": GATES,
                "details": {
                    "trained": metrics,
                    "similarityBaseline": baseline_metrics,
                    "dataset": {
                        "id": export.get("datasetId"),
                        "version": export.get("version"),
                        "sha256": dataset_sha,
                    },
                },
            }
        ],
        "metrics": suite_metrics,
        "passes": passed,
        "artifact": str(out_dir),
        "notes": (
            "Trained linear probe on frozen embeddings. Promotion still requires a passing "
            "report that beats the active baseline (ADR-0017)."
        ),
    }
    (out_dir / "eval-report.json").write_text(json.dumps(eval_report, indent=2), encoding="utf-8")

    report = {
        "generatedAt": eval_report["generatedAt"],
        "kind": "linear-probe-training",
        "modelVersion": model_version,
        "artifactRef": artifact_ref,
        "embeddingModel": args.embedding_model,
        "datasetSha256": dataset_sha,
        "datasetVersion": export.get("version"),
        "codeSha": code_sha(),
        "configHash": hashlib.sha256(
            json.dumps({"seed": args.seed, "model": args.embedding_model}, sort_keys=True).encode()
        ).hexdigest(),
        "python": platform.python_version(),
        "metrics": metrics,
        "baselineMetrics": baseline_metrics,
        "beatsBaseline": bool(delta is not None and delta > 0),
        "gates": {"passed": passed, **GATES},
        "note": "test split metrics only; training accuracy is not an eval metric",
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    if args.register:
        registered = post_json(
            args.api_url,
            "/api/v1/models",
            {
                "component": "classifier",
                "name": args.name or model_version,
                "artifactRef": artifact_ref,
                "config": {
                    "kind": "linear-probe",
                    "embeddingModel": args.embedding_model,
                    "datasetSha256": dataset_sha,
                },
                "actor": args.actor,
            },
        )
        eval_report["subjectModelId"] = registered["id"]
        (out_dir / "eval-report.json").write_text(
            json.dumps(eval_report, indent=2), encoding="utf-8"
        )
        ingested = post_json(args.api_url, "/api/v1/models/eval-reports", eval_report)
        report["evalReportId"] = ingested["id"]
        (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        if args.promote:
            promoted = post_json(
                args.api_url,
                f"/api/v1/models/{registered['id']}/promote",
                {"actor": args.actor},
            )
            report["promoted"] = promoted.get("status") == "active"

    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
