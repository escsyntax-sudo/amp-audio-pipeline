from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_READBACK_CHARS = 1200


def synthesize(text: str, target: Path) -> tuple[Path | None, bool]:
    """Render a readback of the transcript with pyttsx3.

    Returns (path, truncated). Failures are logged and treated as a skipped artifact
    because pyttsx3 needs a working speech backend on the host.
    """
    if not text.strip():
        return None, False
    try:
        import pyttsx3
    except ImportError:
        logger.warning("pyttsx3 is not installed, skipping readback audio")
        return None, False

    truncated = len(text) > MAX_READBACK_CHARS
    spoken = text[:MAX_READBACK_CHARS]
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        engine = pyttsx3.init()
        engine.save_to_file(spoken, str(target))
        engine.runAndWait()
    except Exception as exc:  # noqa: BLE001 - backend errors vary by platform
        logger.warning("text to speech failed: %s", exc)
        return None, False
    if not target.exists() or target.stat().st_size == 0:
        logger.warning("text to speech produced no audio")
        return None, False
    return target, truncated
