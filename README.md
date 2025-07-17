# Optimized Versions Server
> A Streamyfin companion server with GPU support for better downloads with intelligent caching

## About

Optimized Versions Server is a transcoding and caching server that acts as a middleman between Jellyfin and the Streamyfin app. It combines HLS streams into single video files and intelligently caches them to eliminate duplicate downloads across devices.

**Key Features:**
- ⏲ **GPU Transcoding**: Utilize your GPU for even faster transcoding
- 🚀 **Smart Caching**: Same content + quality = single cached file shared across devices
- ⏱️ **48-hour Retention**: Files stay available for 48 hours after last access
- 🔄 **Zero Duplication**: No more downloading the same movie twice on different devices
- 📱 **Background Downloads**: Download continues even when app is closed
- 🔧 **100% Compatible**: Works with existing Streamyfin apps without changes

The download process:
1. **Optimize**: Server downloads and combines HLS stream
2. **Download**: Client downloads the optimized file (shared between devices)

## Usage

Note: The server works best if it's on the same server as the Jellyfin server.

### Docker-compose

#### Docker-compose example

```yaml
services:
  app:
    image: ghcr.io/anonymoesje/optimized-versions-server:latest
    ports:
      - '3000:3000'
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - CACHE_RETENTION_HOURS=48
    restart: unless-stopped
    volumes:
      - ./cache:/usr/src/app/cache
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

Create a .env file following the example below or by copying the .env.example file from this repository.

#### .env example

```bash
# Required
JELLYFIN_URL=http://your-jellyfin-url

# Optional - Performance
MAX_CONCURRENT_JOBS=1                 # Default: 1

# Optional - Cache Management
CACHE_RETENTION_HOURS=48              # Default: 48 hours
CLEANUP_INTERVAL_MINUTES=60           # Default: 60 minutes

# Optional - Startup Behavior
CANCEL_INTERRUPTED_JOBS=false         # Default: false - Auto-resume interrupted jobs (false) or mark as failed (true)
```

## How it works

### 1. Optimize

A POST request is made to the server with the HLS stream URL. The server will then start a job using the GPU, downloading the HLS stream to the server, and convert it to a single file. 

In the meantime, the app will poll the server for the progress of the optimize. 

### 2. Download

As soon as the server is finished with the conversion the app (if open) will start downloading the video file. If the app is not open the download will start as soon as the app is opened. After the download has started the app can be minimized. 

This means that the user needs to 1. initiate the download, and 2. open the app once before download.

## Smart Caching System

The server uses an intelligent caching system that eliminates duplicate downloads:

### How it works
1. **Quality Detection**: Extracts quality parameters from Jellyfin URLs (bitrate, resolution, codec)
2. **Smart Deduplication**: Same item + quality = single cached file
3. **Device Sharing**: Multiple devices can download from the same cached file
4. **48-hour Retention**: Files remain available for 48 hours after last access

### Cache Structure
```
cache/
├── items/
│   └── {itemId}/
│       └── qualities/
│           └── {qualityHash}/
│               ├── video.mp4
│               └── metadata.json
└── jobs/
    └── {jobId}.json (maps to cache items)
```

### Benefits
- **No Duplicate Downloads**: Same movie in same quality downloaded once
- **Cross-Device Sharing**: Download on phone, instantly available on tablet
- **Efficient Storage**: Automatic cleanup of old files
- **Backward Compatible**: Works with existing Streamyfin apps

## Other

This server can work with other clients and is not limited to only using the Streamyfin client. Though support needs to be added to the clients by the maintainer.

## Migration from v1

The new caching system is fully backward compatible. Existing deployments will automatically:
- Continue serving existing downloads
- Start using the new cache system for new requests
- Gradually clean up old files based on retention policy

No manual migration is required.
