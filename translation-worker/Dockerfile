FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --ignore-scripts
COPY src ./src
RUN npx tsc

FROM node:22-bookworm-slim AS runner
WORKDIR /app
# ffmpeg is not optional — the worker pulls audio via HLS and pipes PCM
# to Deepgram. Slim base doesn't ship it, so install here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
