# Multi-stage build so the runtime image doesn't carry the toolchain.
# Alpine + Node 20 is small enough for a Hobby-tier deploy but has all
# the C bindings the @livekit/rtc-node native module needs.

FROM node:20-bookworm-slim AS build
WORKDIR /app

# Native deps for @livekit/rtc-node (WebRTC bindings, Opus, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npx tsc

# --- runtime stage -----------------------------------------------------
FROM node:20-bookworm-slim
WORKDIR /app

# Only what the runtime needs — CA certs for HTTPS to LiveKit + Deepgram.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# The worker is a persistent process. `start` runs the agent CLI which
# registers with LiveKit and waits for job dispatches.
CMD ["node", "dist/agent.js", "start"]
