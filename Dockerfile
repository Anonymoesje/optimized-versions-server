# Stage 1: Build the Node.js app
FROM node:22-alpine AS builder

WORKDIR /usr/src/app
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Runtime with ffmpeg and Node.js (Debian-based)
FROM linuxserver/ffmpeg:7.1.1

# Install Node.js runtime (omit npm if not needed at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /usr/src/app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]
