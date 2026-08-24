FROM node:22-alpine AS build

WORKDIR /app

ENV CI=true \
    NODE_OPTIONS=--max-old-space-size=1024 \
    TMPDIR=/tmp/noteforge-test-tmp \
    npm_config_cache=/tmp/noteforge-npm-cache

COPY package.json package-lock.json ./
RUN mkdir -p /tmp/noteforge-test-tmp /tmp/noteforge-npm-cache \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && rm -rf /tmp/noteforge-test-tmp /tmp/noteforge-npm-cache

COPY . .
RUN mkdir -p /tmp/noteforge-test-tmp /tmp/noteforge-npm-cache \
    && npm test -- --maxWorkers=1 --no-file-parallelism --no-cache \
    && npm run build \
    && rm -rf /tmp/noteforge-test-tmp /tmp/noteforge-npm-cache

FROM golang:1.26-alpine AS server-build

WORKDIR /src

COPY go.mod ./
COPY cmd/noteforge-server/ ./cmd/noteforge-server/
COPY packages/diagnostic-schema/ ./packages/diagnostic-schema/

RUN mkdir -p /tmp/noteforge-go-cache /tmp/noteforge-go-tmp \
    && GOCACHE=/tmp/noteforge-go-cache GOTMPDIR=/tmp/noteforge-go-tmp \
        go test -p=1 -parallel=1 -count=1 ./... \
    && GOCACHE=/tmp/noteforge-go-cache GOTMPDIR=/tmp/noteforge-go-tmp CGO_ENABLED=0 \
        go build -p=1 -trimpath -ldflags="-s -w" -o /out/noteforge-server ./cmd/noteforge-server \
    && rm -rf /tmp/noteforge-go-cache /tmp/noteforge-go-tmp

FROM alpine:3.22 AS runtime

WORKDIR /app

COPY --from=server-build --chown=65532:65532 /out/noteforge-server /usr/local/bin/noteforge-server
COPY --from=build --chown=65532:65532 /app/dist/ /app/dist/

USER 65532:65532

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

STOPSIGNAL SIGTERM

CMD ["/usr/local/bin/noteforge-server"]
