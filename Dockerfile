FROM ghcr.io/puppeteer/puppeteer:24.7.2

ARG PDIIIF_SENTRY_DSN
ARG PDIIIF_SENTRY_TUNNEL_ENDPOINT

ENV PDIIIF_SENTRY_DSN=${PDIIIF_SENTRY_DSN}
ENV PDIIIF_SENTRY_TUNNEL_ENDPOINT=${PDIIIF_SENTRY_TUNNEL_ENDPOINT}

WORKDIR /home/pptruser/pdiiif

COPY --chown=pptruser:pptruser . .

USER root
RUN npm install -g pnpm

USER pptruser
RUN pnpm i && cd ./pdiiif-lib && \
    pnpm run build && \
    cd ../pdiiif-web && \
    pnpm run build && \
    cd ../pdiiif-api && \
    pnpm run build && \
    rm -rf ~/.pnpm-store

ENV CFG_PORT=8080
ENV CFG_HOST=0.0.0.0

EXPOSE ${CFG_PORT}

# Set final working directory and command
WORKDIR /home/pptruser/pdiiif/pdiiif-api
CMD ["node", "dist/server.js"]

