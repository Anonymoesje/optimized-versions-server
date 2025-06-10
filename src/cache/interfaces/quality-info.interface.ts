export interface QualityInfo {
  // Video quality parameters
  maxVideoBitrate?: string;
  videoCodec?: string;
  maxWidth?: string;
  maxHeight?: string;
  videoLevel?: string;
  profile?: string;
  maxFramerate?: string;
  videoBitDepth?: string;

  // Audio quality parameters
  audioCodec?: string;
  audioChannels?: string;
  audioBitrate?: string;
  audioSampleRate?: string;
  maxAudioChannels?: string;
  transcodingMaxAudioChannels?: string;

  // Container parameters
  container?: string;
  segmentContainer?: string;

  // Subtitle parameters
  subtitleCodec?: string;
  subtitleMethod?: string;

  // Stream selection parameters (CRITICAL for proper caching)
  audioStreamIndex?: string;        // Which audio track to use
  subtitleStreamIndex?: string;     // Which subtitle track to use
  audioLanguage?: string;           // Audio language preference
  subtitleLanguage?: string;        // Subtitle language preference

  // Timing parameters
  startTimeTicks?: string;          // Start time for clips/segments

  // Session-specific parameters (excluded from quality hash)
  mediaSourceId?: string;
  deviceId?: string;
  playSessionId?: string;
}

export interface QualityMetrics {
  score: number;           // Quality score for comparison
  description: string;     // Human readable description
  estimatedSize: number;   // Estimated file size in bytes
}
