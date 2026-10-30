import asyncio
import json
import wave
from pathlib import Path

import numpy as np

from amp_worker.audio import normalize_to_wav, read_wav, wav_duration
from amp_worker.diarize import SpeakerSegment, assign_speakers
from amp_worker.events import JobEvents
from amp_worker.pipeline import PipelineOptions, run_pipeline
from amp_worker.transcribe import TranscriptSegment, Transcription


def write_tone(path: Path, frequency: float, seconds: float, rate: int = 16000, amplitude: float = 0.4) -> None:
    timeline = np.arange(int(seconds * rate), dtype=np.float32) / rate
    tone = amplitude * np.sin(2 * np.pi * frequency * timeline)
    pcm = (tone * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())


def write_dialogue(path: Path, rate: int = 16000) -> None:
    timeline = np.arange(int(4.0 * rate), dtype=np.float32) / rate
    low = 0.4 * np.sin(2 * np.pi * 180 * timeline)
    high = 0.4 * np.sin(2 * np.pi * 620 * timeline)
    signal = np.where(timeline < 2.0, low, high)
    rng = np.random.default_rng(3)
    signal = signal + rng.normal(0, 0.01, len(signal))
    pcm = (signal * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())


class StubTranscriber:
    def __init__(self) -> None:
        self.calls = []

    def transcribe(self, audio_path, language="auto", duration=0.0, on_progress=None):
        self.calls.append((audio_path, language, duration))
        if on_progress:
            on_progress(1.0)
        return Transcription(
            language="en",
            language_probability=0.98,
            model="stub",
            segments=[
                TranscriptSegment(0.0, 0.9, "first speaker here"),
                TranscriptSegment(1.0, 1.9, "first speaker continues"),
                TranscriptSegment(2.0, 2.9, "second speaker replies"),
                TranscriptSegment(3.0, 3.9, "second speaker closes"),
            ],
        )


def test_wav_round_trip(tmp_path):
    source = tmp_path / "tone.wav"
    write_tone(source, 440, 1.0)
    samples, rate = read_wav(source)
    assert rate == 16000
    assert len(samples) == 16000
    assert 0.99 <= wav_duration(source) <= 1.01

    target = tmp_path / "normalized.wav"
    normalize_to_wav(source, target)
    assert target.exists()


def test_diarization_separates_two_tones(tmp_path):
    source = tmp_path / "dialogue.wav"
    write_dialogue(source)
    samples, rate = read_wav(source)
    segments = [
        SpeakerSegment(0.2, 0.9, "a"),
        SpeakerSegment(1.1, 1.8, "b"),
        SpeakerSegment(2.1, 2.9, "c"),
        SpeakerSegment(3.1, 3.8, "d"),
    ]
    labelled, count = assign_speakers(samples, rate, segments)
    assert count == 2
    assert labelled[0].speaker == labelled[1].speaker
    assert labelled[2].speaker == labelled[3].speaker
    assert labelled[0].speaker != labelled[2].speaker


def test_pipeline_produces_segments_and_turns(tmp_path):
    source = tmp_path / "input.wav"
    write_dialogue(source)
    transcriber = StubTranscriber()
    seen = []

    result = run_pipeline(
        source,
        tmp_path / "work",
        PipelineOptions(language="en", diarize=True, tts=False),
        transcriber,
        lambda percent, stage: seen.append((percent, stage)),
    )

    assert result["text"] == "first speaker here first speaker continues second speaker replies second speaker closes"
    assert result["language"] == "en"
    assert result["speakerCount"] == 2
    assert len(result["segments"]) == 4
    assert result["turns"]
    assert len(result["turns"]) == 2
    assert result["segments"][0]["speaker"] == result["segments"][1]["speaker"]
    assert result["turns"][0]["speaker"] != result["turns"][1]["speaker"]
    assert seen[0][1] == "normalizing"
    assert seen[-1] == (100, "completed")
    assert transcriber.calls[0][2] == 4.0


class FakeAsyncRedis:
    def __init__(self) -> None:
        self.hashes = {}
        self.expirations = {}
        self.published = []

    async def hset(self, key, mapping):
        self.hashes.setdefault(key, {}).update(mapping)
        return len(mapping)

    async def expire(self, key, ttl):
        self.expirations[key] = ttl
        return True

    async def publish(self, channel, payload):
        self.published.append((channel, json.loads(payload)))
        return 1


def test_job_events_write_hash_and_publish():
    async def scenario():
        redis = FakeAsyncRedis()
        events = JobEvents(redis, "amp:events", 3600)
        await events.update("job-1", "user-1", "completed", "completed", 100, result={"text": "hi"})
        return redis

    redis = asyncio.run(scenario())
    stored = redis.hashes["amp:job:job-1"]
    assert stored["status"] == "completed"
    assert json.loads(stored["result"])["text"] == "hi"
    assert redis.expirations["amp:job:job-1"] == 3600
    event = redis.published[0][1]
    assert event["type"] == "job.completed"
    assert event["progress"] == 100
