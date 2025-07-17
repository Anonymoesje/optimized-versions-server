###############
# Stage 1: Build the Node.js app
###############
FROM node:22-alpine AS builder

# Set environment flags
ENV NODE_ENV=production \
    TZ=UTC

# Set working directory
WORKDIR /app

# Install build deps
RUN apk add --no-cache python3 make g++ git

# Install dependencies first (to leverage caching)
COPY package*.json ./
RUN npm ci

# Copy rest of the app and build
COPY . .
RUN npm run build


###############
# Stage 2: Runtime image with FFmpeg + NVIDIA support
###############
FROM ghcr.io/linuxserver/ffmpeg:latest-nvidia

# Install Node.js and production deps only
RUN apk add --no-cache nodejs npm tini

ENV NODE_ENV=production \
    TZ=UTC \
    # NVIDIA runtime (if using Docker with GPU passthrough)
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=all

# Set working directory
WORKDIR /app

# Use Tini for better signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Copy package.json and install production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy build artifacts from the builder
COPY --from=builder /app/dist ./dist

# Expose app port
EXPOSE 3000

# Healthcheck for Docker
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start the app
CMD ["node", "dist/main.js"]
