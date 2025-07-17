# Stage 1: Build the Node.js app
FROM node:22-alpine AS builder

WORKDIR /app
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Runtime with linuxserver/ffmpeg (includes ffmpeg with hw acceleration)
FROM linuxserver/ffmpeg:7.1.1

# Install nodejs and npm (Debian base)
RUN apt-get update && apt-get install -y nodejs npm && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]
