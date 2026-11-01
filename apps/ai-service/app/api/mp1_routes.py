"""MP1 provider endpoints (ADR-0055): embedder and classifier as separate
logical modules sharing one process for now."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.schemas import ClassifyModel
from app.modules import classification
from app.mp1 import Mp1Envelope, parse_envelope, response_for

router = APIRouter(prefix="/mp1")

PROVIDERS = {
    "embedder": {"version": "0.0.1", "capability": "embedder"},
    "classifier": {"version": "0.0.1", "capability": "classifier"},
}


class ServePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capability: str
    method: str
    args: dict = Field(default_factory=dict)


class EmbedArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    texts: list[str] = Field(min_length=1, max_length=128)


class ClassifyArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=20_000)
    model: ClassifyModel | None = None


@router.post("/{module_id}")
async def handle(module_id: str, body: dict) -> dict:
    provider = PROVIDERS.get(module_id)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"unknown provider {module_id}")
    try:
        envelope: Mp1Envelope = parse_envelope(body)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    if envelope.op == "handshake":
        return response_for(
            envelope,
            module_id=module_id,
            version=provider["version"],
            payload={
                "mp": "1.0",
                "moduleId": module_id,
                "version": provider["version"],
                "schemas": ["mp1.handshake@1", "mp1.capability.serve@1", "mp1.response@1"],
                "runMode": "container",
            },
        )
    if envelope.op in {"health", "drain", "stop"}:
        return response_for(
            envelope,
            module_id=module_id,
            version=provider["version"],
            payload={"status": "healthy"},
        )
    if envelope.op == "capability.serve":
        try:
            call = ServePayload.model_validate(envelope.payload)
            if call.capability != provider["capability"]:
                raise ValueError("wrong capability for this provider")
            if module_id == "embedder" and call.method == "embed":
                args = EmbedArgs.model_validate(call.args)
                return response_for(
                    envelope,
                    module_id=module_id,
                    version=provider["version"],
                    payload=classification.embed(args.texts).model_dump(by_alias=True),
                )
            if module_id == "classifier" and call.method == "classify":
                args = ClassifyArgs.model_validate(call.args)
                return response_for(
                    envelope,
                    module_id=module_id,
                    version=provider["version"],
                    payload=classification.classify(args.text, args.model).model_dump(by_alias=True),
                )
            raise ValueError(f"unsupported method {call.method}")
        except (ValidationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
    raise HTTPException(status_code=400, detail=f"unsupported MP1 op {envelope.op}")
