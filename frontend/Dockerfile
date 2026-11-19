# syntax=docker/dockerfile:1

# Builds the admin panel and serves it with nginx, which is also the single
# entry point: /mcp, the OAuth metadata and /admin/api go to the `mcp` service.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY angular.json tsconfig.json tsconfig.app.json ./
COPY public ./public
COPY src ./src
RUN npx ng build --configuration production

FROM nginx:1.27.5-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Production build uses baseHref /admin/. config.json is NOT baked in: it is
# mounted at runtime (see compose.yaml), like on the VPS.
COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html/admin
EXPOSE 80
