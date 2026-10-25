"""Serving-path boundary (Phase 7): inference must never import trainer code."""

import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
FORBIDDEN = re.compile(r"^\s*(from\s+train(\.|\s)|import\s+train(\s|$))", re.MULTILINE)


def test_serving_path_does_not_import_trainer() -> None:
    offenders = [
        str(path.relative_to(APP))
        for path in APP.rglob("*.py")
        if FORBIDDEN.search(path.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_trainer_is_not_inside_the_serving_package() -> None:
    assert not (APP / "train").exists()
    assert (Path(__file__).resolve().parents[1] / "train" / "linear_probe.py").is_file()
