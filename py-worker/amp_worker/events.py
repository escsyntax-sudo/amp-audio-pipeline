from __future__ import annotations

import json
from typing import Any

import redis.asyncio as aioredis


class JobEvents:
    def __init__(self, redis: aioredis.Redis, channel: str, ttl_seconds: int) -> None:
        self.redis = redis
        self.channel = channel
        self.ttl_seconds = ttl_seconds

    async def update(
        self,
        job_id: str,
        user_id: str | None,
        status: str,
        stage: str,
        progress: int,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        fields: dict[str, str] = {
            "id": job_id,
            "status": status,
            "stage": stage,
            "progress": str(progress),
        }
        if user_id:
            fields["userId"] = user_id
        if result is not None:
            fields["result"] = json.dumps(result)
        if error is not None:
            fields["error"] = error

        key = f"amp:job:{job_id}"
        await self.redis.hset(key, mapping=fields)
        await self.redis.expire(key, self.ttl_seconds)

        event = {
            "type": f"job.{status}",
            "jobId": job_id,
            "userId": user_id,
            "status": status,
            "stage": stage,
            "progress": progress,
        }
        if error:
            event["error"] = error
        await self.redis.publish(self.channel, json.dumps(event))


class SyncProgress:
    """Progress reporter for worker threads, using a blocking Redis connection."""

    def __init__(self, redis, channel: str, job_id: str, user_id: str | None, ttl_seconds: int) -> None:
        self.redis = redis
        self.channel = channel
        self.job_id = job_id
        self.user_id = user_id
        self.ttl_seconds = ttl_seconds
        self.last = -1

    def __call__(self, percent: int, stage: str) -> None:
        if percent < self.last and percent != 100:
            return
        if percent - self.last < 3 and percent != 100:
            return
        self.last = percent
        key = f"amp:job:{self.job_id}"
        fields = {"progress": str(percent), "stage": stage, "status": "running"}
        if self.user_id:
            fields["userId"] = self.user_id
        self.redis.hset(key, mapping=fields)
        self.redis.expire(key, self.ttl_seconds)
        self.redis.publish(
            self.channel,
            json.dumps(
                {
                    "type": "job.running",
                    "jobId": self.job_id,
                    "userId": self.user_id,
                    "status": "running",
                    "stage": stage,
                    "progress": percent,
                }
            ),
        )
