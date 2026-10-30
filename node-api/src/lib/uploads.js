import path from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const KEY = (id) => `amp:upload:${id}`;

export function sanitizeFilename(name) {
  const base = path.basename(String(name ?? "")).replace(/[^A-Za-z0-9._-]/g, "_");
  const trimmed = base.replace(/^\.+/, "").slice(-120);
  return trimmed || "audio.bin";
}

function parseRecord(raw) {
  if (!raw || !raw.id) {
    return null;
  }
  return {
    id: raw.id,
    userId: raw.userId,
    filename: raw.filename,
    contentType: raw.contentType,
    totalChunks: Number(raw.totalChunks),
    sizeBytes: Number(raw.sizeBytes),
    chunkSize: Number(raw.chunkSize),
    status: raw.status,
    createdAt: raw.createdAt,
  };
}

export class UploadRepository {
  constructor(redis, { storageDir, chunkSize, maxUploadBytes }) {
    this.redis = redis;
    this.storageDir = storageDir;
    this.chunkSize = chunkSize;
    this.maxUploadBytes = maxUploadBytes;
  }

  async init({ userId, filename, contentType, totalChunks, sizeBytes }) {
    const record = {
      id: randomUUID(),
      userId,
      filename: sanitizeFilename(filename),
      contentType,
      totalChunks: String(totalChunks),
      sizeBytes: String(sizeBytes),
      chunkSize: String(this.chunkSize),
      status: "uploading",
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.directory(record.id), { recursive: true });
    await this.redis.hset(KEY(record.id), record);
    await this.redis.expire(KEY(record.id), 24 * 60 * 60);
    return parseRecord(record);
  }

  directory(uploadId) {
    return path.join(this.storageDir, uploadId);
  }

  async get(uploadId) {
    return parseRecord(await this.redis.hgetall(KEY(uploadId)));
  }

  async writeChunk(uploadId, index, buffer) {
    const record = await this.get(uploadId);
    if (!record) {
      return { error: "not_found" };
    }
    if (record.status !== "uploading") {
      return { error: "not_uploading" };
    }
    if (!Number.isInteger(index) || index < 0 || index >= record.totalChunks) {
      return { error: "invalid_index" };
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return { error: "empty_chunk" };
    }
    if (buffer.length > record.chunkSize + 1024) {
      return { error: "chunk_too_large" };
    }
    await writeFile(path.join(this.directory(uploadId), `${index}.part`), buffer);
    return { record };
  }

  async assemble(uploadId) {
    const record = await this.get(uploadId);
    if (!record) {
      return { error: "not_found" };
    }
    if (record.status !== "uploading") {
      return { error: "not_uploading" };
    }

    const dir = this.directory(uploadId);
    const parts = new Set(await readdir(dir));
    for (let index = 0; index < record.totalChunks; index += 1) {
      if (!parts.has(`${index}.part`)) {
        return { error: "missing_chunks", missing: index };
      }
    }

    const extension = path.extname(record.filename).toLowerCase() || ".bin";
    const target = path.join(dir, `source${extension}`);
    const sink = createWriteStream(target);
    for (let index = 0; index < record.totalChunks; index += 1) {
      await pipeline(createReadStream(path.join(dir, `${index}.part`)), sink, { end: false });
    }
    await new Promise((resolve, reject) => {
      sink.end((error) => (error ? reject(error) : resolve()));
    });

    const { size } = await stat(target);
    if (size > this.maxUploadBytes) {
      await rm(dir, { recursive: true, force: true });
      return { error: "upload_too_large" };
    }
    if (size !== record.sizeBytes) {
      await rm(dir, { recursive: true, force: true });
      return { error: "size_mismatch", expected: record.sizeBytes, actual: size };
    }

    for (const part of parts) {
      if (part.endsWith(".part")) {
        await rm(path.join(dir, part), { force: true });
      }
    }

    await this.redis.hset(KEY(uploadId), { status: "completed" });
    return { record, path: target, sizeBytes: size };
  }

  async cancel(uploadId) {
    const record = await this.get(uploadId);
    if (!record) {
      return false;
    }
    await rm(this.directory(uploadId), { recursive: true, force: true });
    await this.redis.del(KEY(uploadId));
    return true;
  }
}
