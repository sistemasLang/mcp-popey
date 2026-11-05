# syntax=docker/dockerfile:1

# glibc base: TypeScript 7 ships a native compiler binary per platform.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3030
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node config ./config
# users.yaml lives here; mount a volume to persist it.
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3030
# /mcp answers 401 without a token, which is enough to know the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||3030)+'/mcp').then(r=>process.exit(r.status===401?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
