FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg espeak-ng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
COPY amp_worker ./amp_worker
RUN pip install --no-cache-dir .

RUN useradd --create-home --shell /usr/sbin/nologin worker \
    && mkdir -p /data/uploads /data/results /models \
    && chown -R worker:worker /data /models /app

USER worker

ENV AMP_STORAGE_ROOT=/data/uploads \
    AMP_OUTPUT_DIR=/data/results

CMD ["python", "-m", "amp_worker.main"]
