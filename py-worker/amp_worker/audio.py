from __future__ import annotations

import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np


class AudioError(RuntimeError):
    pass


def normalize_to_wav(source: Path, target: Path) -> Path:
    """Convert any ffmpeg-readable input into 16 kHz mono PCM WAV."""
    target.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        completed = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(target),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0:
            raise AudioError(f"ffmpeg failed: {completed.stderr.strip()[:400]}")
        return target

    if source.suffix.lower() != ".wav":
        raise AudioError("ffmpeg is required to convert non-WAV audio")
    shutil.copyfile(source, target)
    return target


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    try:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError) as exc:
        raise AudioError(f"cannot read WAV file: {exc}") from exc

    if width != 2:
        raise AudioError(f"expected 16-bit PCM, got sample width {width}")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        frames = handle.getnframes()
    return frames / rate if rate else 0.0
