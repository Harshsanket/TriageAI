import pytest
from pydantic import ValidationError

from app.api.schemas import EmbedRequest


def test_embed_request_rejects_oversized_text() -> None:
    with pytest.raises(ValidationError):
        EmbedRequest(texts=["x" * 20_001])


def test_embed_request_accepts_a_long_but_bounded_text() -> None:
    request = EmbedRequest(texts=["x" * 20_000])
    assert len(request.texts[0]) == 20_000
