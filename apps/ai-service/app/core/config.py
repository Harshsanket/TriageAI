from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven configuration. Fails fast on boot if values are invalid."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    log_level: str = "info"
    host: str = "0.0.0.0"
    port: int = 8000

    # Embedding / classification (local weights only; never a hosted API).
    embedding_model: str = "all-MiniLM-L6-v2"
    embedding_device: str = "cpu"
    embedding_batch_size: int = 32
    classifier_threshold: float = 0.35
    classifier_margin: float = 0.05
    exemplars_path: str = ""
    preload_model: bool = True

    # Phase 7 trained classifier: artifacts are resolved under this root only.
    # `classifier_artifact` pins a default artifact (config-only selection);
    # otherwise the host sends the active registry pointer per request.
    artifacts_dir: str = "artifacts"
    classifier_artifact: str = ""

    # Local-only generation adapters (Phase 3). No hosted LLM APIs.
    llm_provider: str = "ollama"  # mlx | lmstudio | ollama
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "smollm2:360m-instruct"
    lmstudio_base_url: str = "http://localhost:1234/v1"
    mlx_model_path: str = ""


settings = Settings()
