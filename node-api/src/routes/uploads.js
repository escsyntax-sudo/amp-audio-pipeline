import { randomUUID } from "node:crypto";

const initSchema = {
  type: "object",
  required: ["filename", "contentType", "totalChunks", "sizeBytes"],
  additionalProperties: false,
  properties: {
    filename: { type: "string", minLength: 1, maxLength: 255 },
    contentType: { type: "string", minLength: 1, maxLength: 120 },
    totalChunks: { type: "integer", minimum: 1, maximum: 5000 },
    sizeBytes: { type: "integer", minimum: 1 },
  },
};

const ERROR_STATUS = {
  not_found: 404,
  not_uploading: 409,
  invalid_index: 400,
  empty_chunk: 400,
  chunk_too_large: 413,
  missing_chunks: 409,
  upload_too_large: 413,
  size_mismatch: 409,
};

function failure(reply, result) {
  const body = { error: result.error };
  if (result.missing !== undefined) body.missingChunk = result.missing;
  if (result.expected !== undefined) {
    body.expectedBytes = result.expected;
    body.actualBytes = result.actual;
  }
  return reply.code(ERROR_STATUS[result.error] ?? 400).send(body);
}

export async function uploadRoutes(app, { uploads, jobs, queue, config }) {
  app.post(
    "/uploads",
    {
      preHandler: app.authenticate,
      schema: { body: initSchema },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { filename, contentType, totalChunks, sizeBytes } = request.body;
      if (!/^(audio|video)\//.test(contentType) && contentType !== "application/octet-stream") {
        return reply.code(415).send({ error: "unsupported_content_type" });
      }
      if (sizeBytes > config.maxUploadBytes) {
        return reply.code(413).send({ error: "upload_too_large" });
      }
      if (totalChunks > config.maxChunks) {
        return reply.code(400).send({ error: "too_many_chunks" });
      }
      const upload = await uploads.init({
        userId: request.user.sub,
        filename,
        contentType,
        totalChunks,
        sizeBytes,
      });
      return reply.code(201).send({
        uploadId: upload.id,
        chunkSize: upload.chunkSize,
        totalChunks: upload.totalChunks,
      });
    },
  );

  app.put(
    "/uploads/:uploadId/chunks/:index",
    {
      preHandler: app.authenticate,
      bodyLimit: config.maxChunkBytes + 1024,
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const index = Number.parseInt(request.params.index, 10);
      const upload = await uploads.get(request.params.uploadId);
      if (!upload) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (upload.userId !== request.user.sub) {
        return reply.code(404).send({ error: "not_found" });
      }
      const result = await uploads.writeChunk(upload.id, index, request.body);
      if (result.error) {
        return failure(reply, result);
      }
      return reply.send({ received: index, totalChunks: upload.totalChunks });
    },
  );

  app.post(
    "/uploads/:uploadId/complete",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = request.body ?? {};
      if (body.language !== undefined && (typeof body.language !== "string" || body.language.length > 12)) {
        return reply.code(400).send({ error: "invalid_language" });
      }
      if (body.diarize !== undefined && typeof body.diarize !== "boolean") {
        return reply.code(400).send({ error: "invalid_diarize_flag" });
      }
      if (body.tts !== undefined && typeof body.tts !== "boolean") {
        return reply.code(400).send({ error: "invalid_tts_flag" });
      }

      const upload = await uploads.get(request.params.uploadId);
      if (!upload || upload.userId !== request.user.sub) {
        return reply.code(404).send({ error: "not_found" });
      }
      const assembled = await uploads.assemble(upload.id);
      if (assembled.error) {
        return failure(reply, assembled);
      }

      const jobId = randomUUID();
      const options = {
        language: body.language ?? "auto",
        diarize: body.diarize ?? true,
        tts: body.tts ?? false,
      };
      const job = await jobs.create({
        id: jobId,
        userId: request.user.sub,
        uploadId: upload.id,
        filename: upload.filename,
      });

      try {
        await queue.add(
          "transcribe",
          {
            jobId,
            userId: request.user.sub,
            uploadId: upload.id,
            path: assembled.path,
            filename: upload.filename,
            contentType: upload.contentType,
            sizeBytes: assembled.sizeBytes,
            ...options,
          },
          { jobId },
        );
      } catch (error) {
        request.log.error({ err: error, jobId }, "failed to enqueue transcription");
        await jobs.update(jobId, {
          status: "failed",
          stage: "enqueue",
          error: "queue_unavailable",
        });
        return reply.code(503).send({ error: "queue_unavailable", jobId });
      }

      return reply.code(202).send({
        jobId: job.id,
        status: job.status,
        uploadId: upload.id,
      });
    },
  );

  app.delete("/uploads/:uploadId", { preHandler: app.authenticate }, async (request, reply) => {
    const upload = await uploads.get(request.params.uploadId);
    if (!upload || upload.userId !== request.user.sub) {
      return reply.code(404).send({ error: "not_found" });
    }
    await uploads.cancel(upload.id);
    return reply.code(204).send();
  });
}
