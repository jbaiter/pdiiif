FROM node:20-bookworm-slim

ARG PDIIIF_SENTRY_DSN
ARG PDIIIF_SENTRY_TUNNEL_ENDPOINT

# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chromium that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y wget gnupg fonts-noto libxss1  ca-certificates fonts-liberation \
     libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libc6 libcairo2 libcups2 \
     libcurl4 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
     libpango-1.0-0 libu2f-udev libvulkan1 libx11-6 libxcb1 libxcomposite1 libxdamage1 \
     libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm


# If running Docker >= 1.13.0 use docker run's --init arg to reap zombie processes, otherwise
# uncomment the following lines to have `dumb-init` as PID 1
# ADD https://github.com/Yelp/dumb-init/releases/download/v1.2.2/dumb-init_1.2.2_x86_64 /usr/local/bin/dumb-init
# RUN chmod +x /usr/local/bin/dumb-init
# ENTRYPOINT ["dumb-init", "--"]

WORKDIR /opt/pdiiif

# Add user so we don't need --no-sandbox for puppeteer
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /opt/pdiiif

# Run everything after as non-privileged user.
USER pptruser

COPY --chown=pptruser . .

WORKDIR /opt/pdiiif
RUN cd pdiiif-lib && \
    pnpm i && pnpm build && \
    cd ../pdiiif-web && \
    pnpm i && pnpm build && \
    cd ../pdiiif-api && \
    pnpm i && pnpm run build && \
    rm -rf ~/.pnpm-store

ENV CFG_PORT 8080
ENV CFG_HOST 0.0.0.0

EXPOSE ${CFG_PORT}

WORKDIR /opt/pdiiif/pdiiif-api
CMD ["node", "dist/server.js"]
