from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FRAME_SECONDS = 0.025
HOP_SECONDS = 0.010
N_MELS = 26
N_MFCC = 13
MAX_CLUSTER_SAMPLES = 400
MIN_SPLIT_SCORE = 0.08


@dataclass
class SpeakerSegment:
    start: float
    end: float
    text: str
    speaker: str = "SPEAKER_00"


def _mel_filterbank(rate: int, fft_size: int, n_mels: int = N_MELS) -> np.ndarray:
    def hz_to_mel(hz: float) -> float:
        return 2595.0 * np.log10(1.0 + hz / 700.0)

    def mel_to_hz(mel: float) -> float:
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

    low = hz_to_mel(20.0)
    high = hz_to_mel(rate / 2.0)
    points = np.linspace(low, high, n_mels + 2)
    hz_points = np.array([mel_to_hz(point) for point in points])
    bins = np.floor((fft_size + 1) * hz_points / rate).astype(int)
    bins = np.clip(bins, 0, fft_size // 2)

    filters = np.zeros((n_mels, fft_size // 2 + 1), dtype=np.float32)
    for index in range(n_mels):
        left, center, right = bins[index], bins[index + 1], bins[index + 2]
        if center == left:
            center = min(left + 1, fft_size // 2)
        if right == center:
            right = min(center + 1, fft_size // 2)
        for bin_index in range(left, center):
            filters[index, bin_index] = (bin_index - left) / max(center - left, 1)
        for bin_index in range(center, right):
            filters[index, bin_index] = (right - bin_index) / max(right - center, 1)
    return filters


def _dct_matrix(n_in: int, n_out: int) -> np.ndarray:
    k = np.arange(n_out)[:, None]
    n = np.arange(n_in)[None, :]
    return np.cos(np.pi / n_in * (n + 0.5) * k) * np.sqrt(2.0 / n_in)


def segment_features(samples: np.ndarray, rate: int, start: float, end: float) -> np.ndarray:
    window = int(FRAME_SECONDS * rate)
    hop = int(HOP_SECONDS * rate)
    begin = max(0, int(start * rate))
    finish = min(len(samples), int(end * rate))
    chunk = samples[begin:finish]
    if len(chunk) < window:
        chunk = np.pad(chunk, (0, window - len(chunk)))

    frames = np.lib.stride_tricks.sliding_window_view(chunk, window)[::hop]
    if len(frames) == 0:
        frames = chunk[:window].reshape(1, -1)
    windowed = frames * np.hanning(window)
    power = np.abs(np.fft.rfft(windowed, axis=1)) ** 2
    mel = power @ _mel_filterbank(rate, 2 * (window // 2)).T
    log_mel = np.log(np.maximum(mel, 1e-10))
    mfcc = log_mel @ _dct_matrix(N_MELS, N_MFCC).T
    return np.concatenate([mfcc.mean(axis=0), mfcc.std(axis=0)]).astype(np.float32)


def _kmeans(features: np.ndarray, k: int, seed: int = 7) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    centers = [features[rng.integers(len(features))]]
    for _ in range(1, k):
        distances = np.min(
            np.linalg.norm(features[:, None, :] - np.array(centers)[None, :, :], axis=2),
            axis=1,
        )
        probabilities = distances**2
        probabilities = probabilities / probabilities.sum() if probabilities.sum() else None
        centers.append(features[rng.choice(len(features), p=probabilities)])
    centers_array = np.array(centers)

    labels = np.zeros(len(features), dtype=int)
    for _ in range(50):
        distances = np.linalg.norm(features[:, None, :] - centers_array[None, :, :], axis=2)
        next_labels = np.argmin(distances, axis=1)
        if np.array_equal(labels, next_labels):
            break
        labels = next_labels
        for index in range(k):
            members = features[labels == index]
            if len(members) > 0:
                centers_array[index] = members.mean(axis=0)
    return labels, centers_array


def _silhouette(features: np.ndarray, labels: np.ndarray) -> float:
    unique = np.unique(labels)
    if len(unique) < 2 or len(features) > 1200:
        return 0.0
    distances = np.linalg.norm(features[:, None, :] - features[None, :, :], axis=2)
    scores = []
    for row in range(len(features)):
        own = labels[row]
        same = distances[row][labels == own]
        same = same[same > 0]
        if len(same) == 0:
            continue
        a = same.mean()
        b = min(
            distances[row][labels == other].mean()
            for other in unique
            if other != own and np.any(labels == other)
        )
        denominator = max(a, b)
        if denominator > 0:
            scores.append((b - a) / denominator)
    return float(np.mean(scores)) if scores else 0.0


def _merge_turns(segments: list[SpeakerSegment]) -> list[dict]:
    turns: list[dict] = []
    for segment in segments:
        if turns and turns[-1]["speaker"] == segment.speaker:
            turns[-1]["end"] = segment.end
            turns[-1]["text"] = f"{turns[-1]['text']} {segment.text}".strip()
        else:
            turns.append(
                {
                    "speaker": segment.speaker,
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text,
                }
            )
    return turns


def assign_speakers(
    samples: np.ndarray,
    rate: int,
    segments: list[SpeakerSegment],
    max_speakers: int = 4,
) -> tuple[list[SpeakerSegment], int]:
    if len(segments) < 2:
        return segments, 1

    features = np.array(
        [segment_features(samples, rate, segment.start, segment.end) for segment in segments]
    )
    scale = features.std(axis=0)
    scale[scale < 1e-6] = 1.0
    normalized = (features - features.mean(axis=0)) / scale

    sample = normalized
    if len(sample) > MAX_CLUSTER_SAMPLES:
        step = max(1, len(sample) // MAX_CLUSTER_SAMPLES)
        sample = sample[::step]

    best_labels = np.zeros(len(sample), dtype=int)
    best_score = 0.0
    best_k = 1
    for k in range(2, min(max_speakers, len(sample) - 1) + 1):
        labels, _ = _kmeans(sample, k)
        score = _silhouette(sample, labels)
        if score > best_score:
            best_score = score
            best_labels = labels
            best_k = k

    if best_k == 1 or best_score < MIN_SPLIT_SCORE:
        return segments, 1

    _, centers = _kmeans(sample, best_k)
    distances = np.linalg.norm(normalized[:, None, :] - centers[None, :, :], axis=2)
    labels = np.argmin(distances, axis=1)

    for index, segment in enumerate(segments):
        segment.speaker = f"SPEAKER_{labels[index]:02d}"
    return segments, len(set(labels.tolist()))


def speaker_turns(segments: list[SpeakerSegment]) -> list[dict]:
    return _merge_turns(segments)
