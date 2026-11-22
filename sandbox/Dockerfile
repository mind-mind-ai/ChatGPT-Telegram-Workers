# Keep this tag in sync with @cloudflare/sandbox in packages/lib/sandbox/package.json.
FROM node:24-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        git \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@12.4.1

COPY --from=docker.io/cloudflare/sandbox:1.0.3 \
    /usr/local/bin/sandbox-shim \
    /usr/local/bin/sandbox-shim

WORKDIR /workspace
CMD ["sleep", "infinity"]
