# syntax=docker/dockerfile:1
#
# Ridgeline Rust worker: the Axum `server` binary serves the built web frontend
# and bakes uploaded GPX tracks (via GDAL). Build context is the repo root.
#
#   docker build -t ridgeline-server .
#   docker run -p 8787:8787 ridgeline-server
#
# GDAL note: gdal-sys 0.12 ships prebuilt bindings for GDAL 3.4–3.12. Debian
# bookworm's libgdal is 3.6, which is in range — keep the build and runtime on
# the same Debian release so the libgdal soname matches.

# --- web frontend -> /web/dist ---------------------------------------------
FROM node:20-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- rust workers (server + baker) -----------------------------------------
# cargo-chef splits the dependency build into its own layer so it's only rebuilt
# when Cargo.toml/Cargo.lock change — source edits reuse the cached deps layer
# (which persists across CI runs via build-push-action's gha cache).
FROM rust:1-bookworm AS chef
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgdal-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-chef --locked
WORKDIR /src

FROM chef AS planner
COPY tools/asset-baker-rs/ ./
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS rust
COPY --from=planner /src/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY tools/asset-baker-rs/ ./
RUN cargo build --release --bins

# --- runtime ---------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
# libgdal32 = bookworm's GDAL 3.6 runtime soname; pulls libproj (proj.db needed
# for the EPSG:4326->32632 transforms). ca-certificates for the HTTPS DEM/tile fetches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgdal32 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust /src/target/release/server /usr/local/bin/server
COPY --from=rust /src/target/release/baker /usr/local/bin/baker
COPY --from=web /web/dist /app/web/dist
RUN mkdir -p /app/web/public/generated /app/cache
ENV WEB_ROOT=/app/web \
    TREK_CACHE=/app/cache \
    RIDGELINE_SERVER_ADDR=0.0.0.0:8787 \
    RUST_LOG=info
EXPOSE 8787
CMD ["server"]
