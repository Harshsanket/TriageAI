"""Classification eval (Phase 3, CI-blocking).

Measures macro P/R/F1, per-category report, confusion matrix, p95 latency and
the false-auto-routing rate for safety-critical categories (must be 0).
"""

import json
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

from app.modules import classification

ROOT = Path(__file__).resolve().parent
REPORT_DIR = ROOT / "reports"
SAFETY_CATEGORIES = {"security"}
GATES = {"macro_f1": 0.70, "p95_ms": 500.0, "false_auto_routing": 0}


def p95(values: list[float]) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round(0.95 * (len(ordered) - 1))))
    return ordered[index]


def load_blessed_fixtures() -> list[dict[str, object]]:
    """Approved corrections exported by `evals/exportFixtures.eval.ts`.

    Files are optional: CI still runs on the curated set when no corrections
    have been blessed yet.
    """
    blessed_dir = ROOT / "blessed"
    if not blessed_dir.is_dir():
        return []
    fixtures: list[dict[str, object]] = []
    for path in sorted(blessed_dir.glob("*.json")):
        if path.name == "manifest.json":
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        for item in payload.get("examples") or []:
            text = item.get("text")
            expected = item.get("expected")
            if isinstance(text, str) and text and isinstance(expected, str) and expected:
                fixtures.append(
                    {
                        "text": text,
                        "expected": expected,
                        "sourceCandidateId": item.get("sourceCandidateId"),
                        "blessed": True,
                    }
                )
    return fixtures


def merge_fixtures(
    curated: list[dict[str, object]], blessed: list[dict[str, object]]
) -> list[dict[str, object]]:
    """Dedupe by text; blessed corrections replace a curated duplicate."""
    merged: dict[str, dict[str, object]] = {
        str(item["text"]): item for item in curated
    }
    for item in blessed:
        merged[str(item["text"])] = item
    return list(merged.values())


def main() -> int:
    curated = json.loads((ROOT / "fixtures.json").read_text(encoding="utf-8"))
    blessed = load_blessed_fixtures()
    fixtures = merge_fixtures(curated, blessed)
    labels = sorted({item["expected"] for item in fixtures})

    confusion: dict[str, dict[str, int]] = {label: defaultdict(int) for label in labels}
    latencies: list[float] = []
    false_auto: list[dict[str, str]] = []
    rows: list[dict[str, object]] = []

    for item in fixtures:
        started = time.perf_counter()
        result = classification.classify(item["text"])
        latency_ms = (time.perf_counter() - started) * 1000
        latencies.append(latency_ms)

        expected = item["expected"]
        predicted = result.category
        confusion[expected][predicted] += 1
        rows.append(
            {
                "text": item["text"],
                "expected": expected,
                "predicted": predicted,
                "confidence": result.confidence,
                "margin": result.margin,
                "latencyMs": round(latency_ms, 2),
            }
        )

        if expected in SAFETY_CATEGORIES and predicted not in (expected, "unknown"):
            false_auto.append({"text": item["text"], "expected": expected, "predicted": predicted})

    per_category: dict[str, dict[str, float]] = {}
    f1_scores: list[float] = []
    for label in labels:
        tp = confusion[label][label]
        fp = sum(confusion[other][label] for other in labels if other != label)
        fn = sum(confusion[label][other] for other in confusion[label] if other != label)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_category[label] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "support": sum(confusion[label].values()),
        }
        f1_scores.append(f1)

    macro_f1 = statistics.fmean(f1_scores) if f1_scores else 0.0
    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "modelVersion": classification.embeddings.model_version(),
        "fixtures": len(fixtures),
        "blessedFixtures": len(blessed),
        "macroF1": round(macro_f1, 4),
        "p95LatencyMs": round(p95(latencies), 2),
        "falseAutoRouting": {category: false_auto.count for category in []},
        "falseAutoRoutingCount": len(false_auto),
        "falseAutoRoutingExamples": false_auto,
        "perCategory": per_category,
        "confusionMatrix": {label: dict(confusion[label]) for label in labels},
        "gates": GATES,
    }
    report["falseAutoRouting"] = {"count": len(false_auto), "safetyCategories": sorted(SAFETY_CATEGORIES)}

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    (REPORT_DIR / f"classification-{stamp}.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (REPORT_DIR / "latest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(json.dumps({k: report[k] for k in ("fixtures", "macroF1", "p95LatencyMs", "falseAutoRoutingCount")}, indent=2))
    print("\nPer category:")
    for label, metrics in per_category.items():
        print(f"  {label:24s} P={metrics['precision']:.2f} R={metrics['recall']:.2f} F1={metrics['f1']:.2f}")

    failures = []
    if macro_f1 < GATES["macro_f1"]:
        failures.append(f"macro F1 {macro_f1:.3f} < {GATES['macro_f1']}")
    if p95(latencies) > GATES["p95_ms"]:
        failures.append(f"p95 {p95(latencies):.1f}ms > {GATES['p95_ms']}ms")
    if len(false_auto) > GATES["false_auto_routing"]:
        failures.append(f"false auto-routing {len(false_auto)} > {GATES['false_auto_routing']}")

    if failures:
        print("\nGATE FAILURES:\n  - " + "\n  - ".join(failures))
        return 1
    print("\nAll gates passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
