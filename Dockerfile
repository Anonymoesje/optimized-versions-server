# syntax=docker/dockerfile:1.4

# ---- Builder Stage ----
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

# ---- Runtime Stage (Multi-Arch, NVIDIA GPU-ready) ----
FROM --platform=$BUILDPLATFORM nvidia/cuda:12.2.0-runtime-ubuntu22.04 AS base

ARG TARGETARCH
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

CMD ["node", "dist/index.js"]
