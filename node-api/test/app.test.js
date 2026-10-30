import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { buildApp } from "../src/app.js";
import { JobRepository } from "../src/lib/jobs.js";
import { UploadRepository } from "../src/lib/uploads.js";
import { UserRepository } from "../src/lib/users.js";
import { FakeBus, FakeQueue, FakeRedis } from "./fakes.js";

describe("amp api", () => {
  let app;
  let redis;
  let queue;
  let bus;
  let storageDir;

  before(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), "amp-test-"));
    redis = new FakeRedis();
    queue = new FakeQueue();
    bus = new FakeBus();
    const config = {
      jwtSecret: "test-secret",
      jwtExpiresIn: "1h",
      storageDir,
      maxChunkBytes: 1024,
      maxUploadBytes: 4096,
      maxChunks: 10,
      queueName: "test",
      eventsChannel: "test:events",
      maxJobAttempts: 1,
      logLevel: "silent",
      corsOrigin: false,
      nodeEnv: "test",
    };
    app = await buildApp({
      config,
      redis,
      queue,
      bus,
      enableRateLimit: false,
      logger: false,
      users: new UserRepository(redis),
      uploads: new UploadRepository(redis, {
        storageDir,
        chunkSize: config.maxChunkBytes,
        maxUploadBytes: config.maxUploadBytes,
      }),
      jobs: new JobRepository(redis, { channel: config.eventsChannel }),
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  async function register(email = "user@example.com") {
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "correct-horse-battery" },
    });
    assert.equal(response.statusCode, 201);
    return response.json();
  }

  it("registers a user and rejects a duplicate email", async () => {
    const created = await register();
    assert.equal(created.user.email, "user@example.com");
    assert.ok(created.token);

    const duplicate = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "USER@example.com", password: "another-password" },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error, "email_taken");
  });

  it("logs in and rejects a bad password", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "user@example.com", password: "correct-horse-battery" },
    });
    assert.equal(login.statusCode, 200);

    const rejected = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "user@example.com", password: "wrong-password" },
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.json().error, "invalid_credentials");
  });

  it("rejects unauthenticated job access", async () => {
    const response = await app.inject({ method: "GET", url: "/jobs" });
    assert.equal(response.statusCode, 401);
  });

  it("uploads chunks, enqueues a job and reports queued progress", async () => {
    const { token } = await register("uploader@example.com");
    const content = Buffer.from("fake-wave-data");

    const init = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "../../passwd.wav",
        contentType: "audio/wav",
        totalChunks: 2,
        sizeBytes: content.length,
      },
    });
    assert.equal(init.statusCode, 201);
    const { uploadId } = init.json();

    for (let index = 0; index < 2; index += 1) {
      const chunk = content.subarray(index * 7, index * 7 + 7);
      const response = await app.inject({
        method: "PUT",
        url: `/uploads/${uploadId}/chunks/${index}`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/octet-stream",
        },
        payload: chunk,
      });
      assert.equal(response.statusCode, 200, response.body);
    }

    const complete = await app.inject({
      method: "POST",
      url: `/uploads/${uploadId}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { diarize: true, language: "en" },
    });
    assert.equal(complete.statusCode, 202, complete.body);
    const { jobId } = complete.json();
    assert.ok(jobId);

    assert.equal(queue.jobs.length, 1);
    const queued = queue.jobs[0];
    assert.equal(queued.data.jobId, jobId);
    assert.equal(queued.data.filename, "passwd.wav");
    assert.equal(queued.data.diarize, true);
    assert.equal(queued.data.language, "en");
    assert.equal(await readFile(queued.data.path, "utf8"), content.toString());

    const job = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(job.statusCode, 200);
    assert.equal(job.json().job.status, "queued");
    assert.equal(job.json().job.filename, "passwd.wav");

    assert.ok(redis.published.some((event) => event.payload.type === "job.queued"));
  });

  it("refuses to complete when a chunk is missing", async () => {
    const { token } = await register("missing@example.com");
    const init = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "call.wav",
        contentType: "audio/wav",
        totalChunks: 3,
        sizeBytes: 9,
      },
    });
    const { uploadId } = init.json();
    await app.inject({
      method: "PUT",
      url: `/uploads/${uploadId}/chunks/0`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      payload: Buffer.from("abc"),
    });

    const complete = await app.inject({
      method: "POST",
      url: `/uploads/${uploadId}/complete`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(complete.statusCode, 409);
    assert.equal(complete.json().error, "missing_chunks");
    assert.equal(complete.json().missingChunk, 1);
  });

  it("does not expose another user's job", async () => {
    const { token: ownerToken } = await register("owner@example.com");
    const { token: otherToken } = await register("other@example.com");
    const content = Buffer.from("hello audio");

    const init = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        filename: "note.wav",
        contentType: "audio/wav",
        totalChunks: 1,
        sizeBytes: content.length,
      },
    });
    const { uploadId } = init.json();
    await app.inject({
      method: "PUT",
      url: `/uploads/${uploadId}/chunks/0`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/octet-stream",
      },
      payload: content,
    });
    const complete = await app.inject({
      method: "POST",
      url: `/uploads/${uploadId}/complete`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const { jobId } = complete.json();

    const response = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    assert.equal(response.statusCode, 404);
  });

  it("rejects an unsupported content type and oversized uploads", async () => {
    const { token } = await register("limits@example.com");
    const unsupported = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "notes.txt",
        contentType: "text/plain",
        totalChunks: 1,
        sizeBytes: 10,
      },
    });
    assert.equal(unsupported.statusCode, 415);

    const oversized = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "long.wav",
        contentType: "audio/wav",
        totalChunks: 1,
        sizeBytes: 999999,
      },
    });
    assert.equal(oversized.statusCode, 413);
  });
});
