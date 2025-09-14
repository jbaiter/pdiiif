FROM node:24-bookworm-slim

ARG PDIIIF_SENTRY_DSN
ARG PDIIIF_SENTRY_TUNNEL_ENDPOINT

ENV PDIIIF_SENTRY_DSN=${PDIIIF_SENTRY_DSN}
ENV PDIIIF_SENTRY_TUNNEL_ENDPOINT=${PDIIIF_SENTRY_TUNNEL_ENDPOINT}


RUN npm install -g pnpm

RUN pnpx playwright install --with-deps --only-shell chromium

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY pdiiif-api/package.json ./pdiiif-api/
COPY pdiiif-lib/package.json ./pdiiif-lib/
COPY pdiiif-web/package.json ./pdiiif-web/

RUN pnpm i

COPY . .

RUN pnpm run -r build && \
    rm -rf ~/.pnpm-store ~/.local/share/pnpm/store

ENV CFG_PORT=8080
ENV CFG_HOST=0.0.0.0

EXPOSE ${CFG_PORT}

# Set final working directory and command
WORKDIR /app/pdiiif-api
CMD ["node", "dist/server.js"]
