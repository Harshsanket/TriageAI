"""
Response generation — local LLM adapters only (no hosted APIs).

Adapter selection is env-driven (docs/ARCHITECTURE.md §6.3):
  - ollama:    local server via Ollama HTTP API (default for pipeline dev)
  - lmstudio:  local OpenAI-compatible server
  - mlx:       in-process MLX on Apple Silicon (target for the final model
               and for LoRA fine-tuning in Phase 7b)

Model selection happens in Phase 3: evaluate SmolLM2-360M-Instruct and
1-2B instruct candidates; adopt the smallest model meeting the quality bar
(groundedness, instruction-following, formatting, insufficient-info
escalation). Fine-tuning (LoRA/MLX) only after a measured baseline shows
behavioral gaps — never to memorize the knowledge base.
"""

from app.core.config import settings


def describe() -> str:
    return (
        f"local-only generation via {settings.llm_provider} "
        f"(model={settings.ollama_model if settings.llm_provider == 'ollama' else 'see settings'})"
    )


def generate(prompt: str, max_tokens: int = 512) -> dict:
    raise NotImplementedError("Local generation adapter lands in Phase 3")
