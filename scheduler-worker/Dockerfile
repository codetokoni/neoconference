# The scheduler tick: a single file, no dependencies.
FROM node:20-alpine
WORKDIR /app
COPY index.mjs ./
USER node
CMD ["node", "index.mjs"]
