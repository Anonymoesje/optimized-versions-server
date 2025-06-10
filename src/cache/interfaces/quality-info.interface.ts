export interface QualityInfo {
  maxVideoBitrate?: string;
  videoCodec?: string;
  audioCodec?: string;
  maxWidth?: string;
  maxHeight?: string;
  container?: string;
  segmentContainer?: string;
  audioChannels?: string;
  audioBitrate?: string;
  videoLevel?: string;
  profile?: string;
  maxFramerate?: string;
  videoBitDepth?: string;
  audioSampleRate?: string;
  subtitleCodec?: string;
  mediaSourceId?: string;
  deviceId?: string;
  playSessionId?: string;
  // Add other Jellyfin streaming parameters as needed
}

export interface QualityMetrics {
  score: number;           // Quality score for comparison
  description: string;     // Human readable description
  estimatedSize: number;   // Estimated file size in bytes
}
