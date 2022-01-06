FROM node:16-slim

# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chromium that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-noto libxss1 --no-install-recommends \
    && apt-get clean \ 
    && rm -rf /var/lib/apt/lists/*

RUN wget -q -O - https://unpkg.com/@pnpm/self-installer | node

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

# Skip the chromium download when installing puppeteer.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true
ENV CFG_PUPPETEER_BROWSER_EXECUTABLE google-chrome-stable

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

CMD ["node", "dist/server.js"]