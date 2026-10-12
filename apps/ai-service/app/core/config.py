from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven configuration. Fails fast on boot if values are invalid."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    log_level: str = "info"
    host: str = "0.0.0.0"
    port: int = 8000

    # Local-only generation adapters (Phase 3). No hosted LLM APIs.
    llm_provider: str = "ollama"  # mlx | lmstudio | ollama
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "smollm2:360m-instruct"
    lmstudio_base_url: str = "http://localhost:1234/v1"
    mlx_model_path: str = ""


settings = Settings()
