export interface JobMapping {
  jobId: string;
  itemId: string;
  qualityHash: string;
  deviceId: string;
  createdAt: Date;
  lastAccessed: Date;
}

export interface ProcessingJob {
  jobId: string;
  itemId: string;
  qualityHash: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  deviceIds: string[]; // All devices waiting for this item+quality
  ffmpegProcess?: any;
  speed?: number;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}
