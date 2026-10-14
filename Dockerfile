FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev

FROM node:22-bookworm-slim
# ffmpeg/ffprobe: validação e conversão de áudio (OGG/Opus <-> MP3)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./
USER node
EXPOSE 3000
# O mesmo imagem roda a API (padrão), o worker ou as migrações:
#   docker run ... node dist/main-worker.js
#   docker run ... node dist/db/migrate.js
CMD ["node", "dist/main-api.js"]
