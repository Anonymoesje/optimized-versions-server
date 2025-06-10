import { QualityInfo } from './quality-info.interface';

export interface CacheItem {
  itemId: string;
  qualityHash: string;
  qualityInfo: QualityInfo;
  status: 'processing' | 'completed' | 'failed';
  filePath: string;
  createdAt: Date;
  lastAccessed: Date;
  completedAt?: Date;
  size: number;
  originalUrl: string;
  waitingDevices: string[]; // DeviceIds waiting for this item
  metadata?: any; // Original item metadata from Jellyfin
  progress: number; // 0-100
  speed?: number; // Processing speed
  error?: string; // Error message if failed
}

export interface ItemInfo {
  itemId: string;
  name?: string;
  type?: string;
  availableQualities: string[]; // Array of qualityHashes
  createdAt: Date;
  lastAccessed: Date;
  totalSize: number; // Total size of all qualities
}

export interface CacheStats {
  totalItems: number;
  totalQualities: number;
  totalSize: number;
  oldestItem: Date;
  newestItem: Date;
  itemsReadyForCleanup: number;
  activeProcessingJobs: number;
  completedJobs: number;
  failedJobs: number;
}
