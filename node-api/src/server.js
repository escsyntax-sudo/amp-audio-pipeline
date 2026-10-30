import { mkdir } from "node:fs/promises";
import Redis from "ioredis";

import { config } from "./config.js";
import { buildApp } from "./app.js";
import { createQueue } from "./lib/queue.js";
import { UserRepository } from "./lib/users.js";
import { UploadRepository } from "./lib/uploads.js";
import { JobRepository } from "./lib/jobs.js";
import { ProgressBus } from "./lib/progress-bus.js";

async function main() {
  await mkdir(config.storageDir, { recursive: true });

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const queue = createQueue({
    redisUrl: config.redisUrl,
    name: config.queueName,
    attempts: config.maxJobAttempts,
  });
  const bus = new ProgressBus(redis, config.eventsChannel);
  await bus.start();

  const app = await buildApp({
    config,
    redis,
    queue,
    bus,
    users: new UserRepository(redis),
    uploads: new UploadRepository(redis, {
      storageDir: config.storageDir,
      chunkSize: config.maxChunkBytes,
      maxUploadBytes: config.maxUploadBytes,
    }),
    jobs: new JobRepository(redis, { channel: config.eventsChannel }),
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ queue: config.queueName, storage: config.storageDir }, "amp api ready");

  const shutdown = async (signal) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await bus.close();
    await queue.close();
    await redis.quit();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
