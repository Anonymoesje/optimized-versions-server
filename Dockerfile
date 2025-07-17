# syntax=docker/dockerfile:1.4

# -------- Builder Stage --------
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# -------- Runtime Stage with CUDA 12.9 + Node + FFmpeg --------
FROM nvidia/cuda:12.9.0-runtime-ubuntu22.04

# Install Node.js, npm, and ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built app and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

# Expose app port (adjust if needed)
EXPOSE 3000

CMD ["node", "dist/main.js"]
