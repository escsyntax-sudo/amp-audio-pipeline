from __future__ import annotations

import asyncio
import json
import logging
import signal
from pathlib import Path

import redis
import redis.asyncio as aioredis
from bullmq import Worker

from .config import Settings, load_settings
from .events import JobEvents, SyncProgress
from .pipeline import PipelineOptions, run_pipeline
from .transcribe import FasterWhisperTranscriber

logger = logging.getLogger("amp_worker")


def resolve_source(raw_path: str, allowed_root: Path) -> Path:
    path = Path(raw_path).resolve()
    if not path.is_relative_to(allowed_root):
        raise PermissionError(f"job path escapes the storage root: {path}")
    if not path.is_file():
        raise FileNotFoundError(f"job path does not exist: {path}")
    return path


def build_processor(
    settings: Settings,
    events: JobEvents,
    transcriber: FasterWhisperTranscriber,
    sync_redis: redis.Redis,
):
    async def process(job, token=None):
        data = job.data or {}
        job_id = str(data.get("jobId") or job.id)
        user_id = data.get("userId")
        logger.info("picked up job %s", job_id)

        await events.update(job_id, user_id, "running", "starting", 1)

        try:
            source = resolve_source(data["path"], settings.allowed_root)
            work_dir = settings.output_dir / job_id
            progress = SyncProgress(
                sync_redis,
                settings.events_channel,
                job_id,
                user_id,
                settings.job_ttl_seconds,
            )
            options = PipelineOptions(
                language=str(data.get("language") or "auto"),
                diarize=bool(data.get("diarize", True)),
                tts=bool(data.get("tts", False)),
            )
            result = await asyncio.to_thread(
                run_pipeline,
                source,
                work_dir,
                options,
                transcriber,
                progress,
                settings.tts_enabled,
            )
            await events.update(job_id, user_id, "completed", "completed", 100, result=result)
            await job.updateProgress(100)
            logger.info("completed job %s in %.1fs", job_id, result["durationSeconds"])
            return result
        except Exception as exc:  # noqa: BLE001 - the message is surfaced to the client
            message = f"{type(exc).__name__}: {exc}"[:800]
            logger.exception("job %s failed", job_id)
            await events.update(job_id, user_id, "failed", "failed", 0, error=message)
            raise

    return process


async def run_worker(settings: Settings) -> None:
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    if not settings.allowed_root.exists():
        logger.warning("storage root %s does not exist yet", settings.allowed_root)

    async_redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    sync_redis = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    events = JobEvents(async_redis, settings.events_channel, settings.job_ttl_seconds)
    transcriber = FasterWhisperTranscriber(
        settings.whisper_model,
        settings.whisper_device,
        settings.whisper_compute_type,
    )

    worker = Worker(
        settings.queue_name,
        build_processor(settings, events, transcriber, sync_redis),
        {
            "connection": settings.redis_url,
            "concurrency": settings.concurrency,
        },
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    def request_stop(*_args) -> None:
        loop.call_soon_threadsafe(stop.set)

    for handled in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(handled, request_stop)
        except (ValueError, OSError):
            pass

    logger.info(
        "worker listening on %s (model=%s, concurrency=%d)",
        settings.queue_name,
        settings.whisper_model,
        settings.concurrency,
    )
    worker_task = asyncio.create_task(worker.run(), name="bullmq-worker")
    stop_task = asyncio.create_task(stop.wait(), name="stop-signal")
    done, pending = await asyncio.wait(
        {worker_task, stop_task},
        return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
    await worker.close()
    if worker_task in done:
        worker_task.result()

    await async_redis.aclose()
    sync_redis.close()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = load_settings()
    try:
        asyncio.run(run_worker(settings))
    except KeyboardInterrupt:
        pass
    except Exception:
        logger.exception("worker stopped unexpectedly")
        raise

    logger.info("worker stopped")


if __name__ == "__main__":
    main()
