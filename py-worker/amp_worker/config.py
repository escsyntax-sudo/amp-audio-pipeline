from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _int(name: str, fallback: int) -> int:
    try:
        return int(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        return fallback


def _bool(name: str, fallback: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return fallback
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    redis_url: str
    queue_name: str
    events_channel: str
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    concurrency: int
    output_dir: Path
    allowed_root: Path
    tts_enabled: bool
    job_ttl_seconds: int


def load_settings() -> Settings:
    output_dir = Path(os.environ.get("AMP_OUTPUT_DIR", "./data/results")).resolve()
    allowed_root = Path(os.environ.get("AMP_STORAGE_ROOT", "./data/uploads")).resolve()
    return Settings(
        redis_url=os.environ.get("REDIS_URL", "redis://127.0.0.1:6379"),
        queue_name=os.environ.get("QUEUE_NAME", "amp-transcribe"),
        events_channel=os.environ.get("EVENTS_CHANNEL", "amp:events"),
        whisper_model=os.environ.get("WHISPER_MODEL", "base"),
        whisper_device=os.environ.get("WHISPER_DEVICE", "cpu"),
        whisper_compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
        concurrency=max(1, _int("WORKER_CONCURRENCY", 1)),
        output_dir=output_dir,
        allowed_root=allowed_root,
        tts_enabled=_bool("TTS_ENABLED", False),
        job_ttl_seconds=max(3600, _int("JOB_TTL_SECONDS", 7 * 24 * 60 * 60)),
    )
