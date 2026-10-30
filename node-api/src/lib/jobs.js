const JOB_KEY = (id) => `amp:job:${id}`;
const USER_JOBS = (id) => `amp:userjobs:${id}`;

function parseJob(raw) {
  if (!raw || !raw.id) {
    return null;
  }
  return {
    id: raw.id,
    userId: raw.userId,
    uploadId: raw.uploadId,
    filename: raw.filename,
    status: raw.status,
    stage: raw.stage,
    progress: Number(raw.progress ?? 0),
    attempts: Number(raw.attempts ?? 0),
    language: raw.language ?? null,
    durationSeconds: raw.durationSeconds ? Number(raw.durationSeconds) : null,
    result: raw.result ? JSON.parse(raw.result) : null,
    error: raw.error ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export class JobRepository {
  constructor(redis, { channel }) {
    this.redis = redis;
    this.channel = channel;
  }

  async create({ id, userId, uploadId, filename }) {
    const now = new Date().toISOString();
    const record = {
      id,
      userId,
      uploadId,
      filename,
      status: "queued",
      stage: "queued",
      progress: "0",
      attempts: "0",
      createdAt: now,
      updatedAt: now,
    };
    await this.redis.hset(JOB_KEY(id), record);
    await this.redis.zadd(USER_JOBS(userId), Date.now(), id);
    await this.publish({ type: "job.queued", jobId: id, userId, status: "queued", stage: "queued", progress: 0 });
    return parseJob(record);
  }

  async get(id) {
    return parseJob(await this.redis.hgetall(JOB_KEY(id)));
  }

  async update(id, patch) {
    const fields = { ...patch, updatedAt: new Date().toISOString() };
    if (fields.result && typeof fields.result !== "string") {
      fields.result = JSON.stringify(fields.result);
    }
    const flat = Object.fromEntries(
      Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, value === null ? "" : String(value)]),
    );
    if (Object.keys(flat).length > 0) {
      await this.redis.hset(JOB_KEY(id), flat);
    }
    const job = await this.get(id);
    if (job) {
      await this.publish({
        type: `job.${job.status}`,
        jobId: job.id,
        userId: job.userId,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        error: job.error,
      });
    }
    return job;
  }

  async listForUser(userId, limit = 25) {
    const ids = await this.redis.zrevrange(USER_JOBS(userId), 0, limit - 1);
    if (ids.length === 0) {
      return [];
    }
    const rows = await Promise.all(ids.map((id) => this.get(id)));
    return rows.filter(Boolean);
  }

  async publish(event) {
    await this.redis.publish(this.channel, JSON.stringify(event));
  }
}
