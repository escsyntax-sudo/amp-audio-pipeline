from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .audio import normalize_to_wav, read_wav, wav_duration
from .diarize import SpeakerSegment, assign_speakers, speaker_turns
from .transcribe import FasterWhisperTranscriber
from .tts import synthesize

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[int, str], None]


@dataclass
class PipelineOptions:
    language: str = "auto"
    diarize: bool = True
    tts: bool = False
    max_speakers: int = 4


def run_pipeline(
    source: Path,
    work_dir: Path,
    options: PipelineOptions,
    transcriber: FasterWhisperTranscriber,
    on_progress: ProgressCallback | None = None,
    tts_enabled: bool = False,
) -> dict:
    def report(percent: int, stage: str) -> None:
        if on_progress:
            on_progress(percent, stage)

    if not source.exists():
        raise FileNotFoundError(f"source audio missing: {source}")

    work_dir.mkdir(parents=True, exist_ok=True)
    wav_path = work_dir / "normalized.wav"
    report(3, "normalizing")
    normalize_to_wav(source, wav_path)
    duration = wav_duration(wav_path)
    report(8, "transcribing")

    def transcription_progress(ratio: float) -> None:
        report(8 + int(ratio * 62), "transcribing")

    transcription = transcriber.transcribe(
        wav_path,
        language=options.language,
        duration=duration,
        on_progress=transcription_progress,
    )
    report(72, "aligning")

    segments = [
        SpeakerSegment(start=item.start, end=item.end, text=item.text)
        for item in transcription.segments
    ]

    speaker_count = 1
    if options.diarize and segments:
        samples, rate = read_wav(wav_path)
        report(78, "diarizing")
        segments, speaker_count = assign_speakers(
            samples,
            rate,
            segments,
            max_speakers=options.max_speakers,
        )

    report(90, "assembling")
    turns = speaker_turns(segments)
    text = " ".join(segment.text for segment in segments).strip()

    result = {
        "text": text,
        "language": transcription.language,
        "languageProbability": round(transcription.language_probability, 4),
        "model": transcription.model,
        "durationSeconds": round(duration, 3),
        "speakerCount": speaker_count,
        "diarization": {
            "enabled": options.diarize,
            "method": "mfcc-kmeans-silhouette",
        },
        "segments": [
            {
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "text": segment.text,
                "speaker": segment.speaker,
            }
            for segment in segments
        ],
        "turns": [
            {
                "speaker": turn["speaker"],
                "start": round(turn["start"], 3),
                "end": round(turn["end"], 3),
                "text": turn["text"],
            }
            for turn in turns
        ],
    }

    if options.tts and tts_enabled:
        report(94, "synthesizing")
        speech_path, truncated = synthesize(text, work_dir / "readback.wav")
        if speech_path:
            result["readback"] = {
                "path": str(speech_path),
                "truncated": truncated,
            }

    report(100, "completed")
    return result
