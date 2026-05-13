# agents/captions-worker/Dockerfile
#
# Multi-stage build for Railway. Compiles TypeScript in a builder image then
# copies the dist/ output and pruned node_modules into a slim runtime image.

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
# LiveKit Agents workers run on demand - they don't bind a port.
# Railway: set service type to "Worker" (no public networking).
CMD ["node", "dist/index.js", "start"]
