FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm ci \
  && npm run build \
  && npm prune --omit=dev

ENTRYPOINT ["node", "dist/cli/index.js"]
