"""
Accelerator probe for the setup wizard (Phase 11): which GPU backend torch can
use here and how much memory it has. The API host owns the rest of the
hardware profile (RAM, CPU, disk); only this process can see torch's view.
"""

from app.api.schemas import HardwareResponse


def probe() -> HardwareResponse:
    try:
        import torch  # deferred: torch is heavy and only needed here and for models
    except Exception:  # noqa: BLE001 - no torch means no accelerator, not an error
        return HardwareResponse(kind="none")

    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        return HardwareResponse(kind="cuda", name=props.name, memoryBytes=int(props.total_memory))
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        # Apple GPUs share system memory; the host reports RAM instead.
        return HardwareResponse(kind="mps", name="Apple GPU (unified memory)")
    return HardwareResponse(kind="none")
