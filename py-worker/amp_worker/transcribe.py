from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable


@dataclass
class TranscriptSegment:
    start: float
    end: float
    text: str


@dataclass
class Transcription:
    language: str
    language_probability: float
    segments: list[TranscriptSegment]
    model: str


class FasterWhisperTranscriber:
    """Lazily loads faster-whisper so the worker can start before models are cached."""

    def __init__(self, model_name: str, device: str, compute_type: str) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self._model = None

    def _load(self):
        if self._model is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise RuntimeError(
                    "faster-whisper is not installed; rebuild the worker image or install requirements"
                ) from exc
            self._model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
            )
        return self._model

    def transcribe(
        self,
        audio_path: Path,
        language: str = "auto",
        duration: float = 0.0,
        on_progress: Callable[[float], None] | None = None,
    ) -> Transcription:
        model = self._load()
        segments_iter, info = model.transcribe(
            str(audio_path),
            language=None if language in {"auto", ""} else language,
            vad_filter=True,
            beam_size=5,
            word_timestamps=False,
        )
        collected: list[TranscriptSegment] = []
        for segment in _iterate(segments_iter):
            text = segment.text.strip()
            if text:
                collected.append(
                    TranscriptSegment(start=segment.start, end=segment.end, text=text)
                )
            if on_progress and duration > 0:
                on_progress(min(segment.end / duration, 1.0))

        return Transcription(
            language=info.language or "unknown",
            language_probability=float(getattr(info, "language_probability", 0.0) or 0.0),
            segments=collected,
            model=self.model_name,
        )


def _iterate(segments: Iterable) -> Iterable:
    for segment in segments:
        yield segment
