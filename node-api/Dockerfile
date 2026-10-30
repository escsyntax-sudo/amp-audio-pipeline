FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    STORAGE_DIR=/data/uploads

RUN mkdir -p /data/uploads && chown -R node:node /data /app

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
