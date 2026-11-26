# Marvii bot: the server (Telegram, glasses API, alerts) and the glasses app it serves.
FROM node:22-slim
# ffmpeg turns Telegram voice notes into the PCM the speech model reads.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY glasses/package.json glasses/package-lock.json glasses/
RUN cd glasses && npm ci
COPY . .
RUN cd glasses && npm run build
ENV NODE_ENV=production PORT=8790 DATA_FILE=/data/store.json MODEL_CACHE=/data/models
EXPOSE 8790
CMD ["node", "server/index.mjs"]
