import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { promises as fsPromises } from 'fs';
import { CACHE_DIR } from './constants';
import { FileRemoval } from './cleanup/removalUtils';
import * as kill from 'tree-kill';
import { CacheService } from './cache/cache.service';
import { QualityService } from './cache/quality.service';
import { JobMappingService } from './cache/job-mapping.service';
import { CacheItem } from './cache/interfaces/cache-item.interface';
import { ProcessingJob } from './cache/interfaces/job-mapping.interface';

export interface Job {
  id: string;
  status: 'queued' | 'optimizing' | 'pending downloads limit' | 'completed' | 'failed' | 'cancelled' | 'ready-for-removal';
  progress: number;
  outputPath: string;
  inputUrl: string;
  deviceId: string;
  itemId: string;
  timestamp: Date;
  size: number;
  item: any;
  speed?: number;
}

@Injectable()
export class AppService {
  // Cache-based system
  private processingJobs: Map<string, ProcessingJob> = new Map(); // itemId_qualityHash -> ProcessingJob
  private ffmpegProcesses: Map<string, ChildProcess> = new Map(); // itemId_qualityHash -> FFmpeg process
  private videoDurations: Map<string, number> = new Map(); // itemId_qualityHash -> duration

  private maxConcurrentJobs: number;
  private cacheDir: string;

  constructor(
    private logger: Logger,
    private configService: ConfigService,
    private readonly fileRemoval: FileRemoval,
    private readonly cacheService: CacheService,
    private readonly qualityService: QualityService,
    private readonly jobMappingService: JobMappingService,
  ) {
    this.cacheDir = CACHE_DIR;
    this.maxConcurrentJobs = this.configService.get<number>(
      'MAX_CONCURRENT_JOBS',
      1,
    );

    // Perform startup cleanup
    this.performStartupCleanup();
  }

  async downloadAndCombine(
    url: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    fileExtension: string,
    deviceId: string,
    itemId: string,
    item: any,
  ): Promise<string> {
    // Extract quality information from URL
    const qualityInfo = this.qualityService.extractQualityFromUrl(url);
    const qualityHash = this.qualityService.generateQualityHash(qualityInfo);
    const qualityDescription = this.qualityService.getQualityDescription(qualityInfo);

    this.logger.log(
      `Optimize request for item ${itemId} | Quality: ${qualityDescription} (${qualityHash}) | Device: ${deviceId}`
    );

    // Check if this item+quality already exists in cache
    const existingCacheItem = this.cacheService.getCacheItem(itemId, qualityHash);

    if (existingCacheItem?.status === 'completed') {
      // Reuse existing completed item
      const jobId = uuidv4();
      await this.jobMappingService.createJobMapping(jobId, itemId, qualityHash, deviceId);
      await this.cacheService.updateLastAccessed(itemId, qualityHash);

      this.logger.log(
        `Reusing existing cache for ${itemId}/${qualityHash} -> job ${jobId}`
      );
      return jobId;
    }

    if (existingCacheItem?.status === 'processing') {
      // Add to waiting list for existing job
      const jobId = uuidv4();
      await this.jobMappingService.createJobMapping(jobId, itemId, qualityHash, deviceId);
      await this.cacheService.addWaitingDevice(itemId, qualityHash, deviceId);

      this.logger.log(
        `Added to waiting list for ${itemId}/${qualityHash} -> job ${jobId}`
      );
      return jobId;
    }

    // Start new optimization
    const jobId = uuidv4();
    const cacheItem = await this.cacheService.createCacheItem(
      itemId,
      qualityHash,
      qualityInfo,
      url,
      item
    );

    await this.jobMappingService.createJobMapping(jobId, itemId, qualityHash, deviceId);

    // Create processing job
    const processingJob: ProcessingJob = {
      jobId,
      itemId,
      qualityHash,
      status: 'queued',
      progress: 0,
      deviceIds: [deviceId],
      createdAt: new Date(),
    };

    const processingKey = `${itemId}_${qualityHash}`;
    this.processingJobs.set(processingKey, processingJob);

    // Check if we can start immediately or need to queue
    if (this.canStartNewJob()) {
      // Mark as processing immediately to prevent race conditions
      processingJob.status = 'processing';

      // Start the optimization process immediately
      this.startOptimizationJob(cacheItem, processingJob).catch(error => {
        this.logger.error(`Failed to start optimization job: ${error.message}`);
      });
    } else {
      // Job will remain in 'pending' status until a slot becomes available
      // Keep processing job status as 'queued' and cache item status as 'pending'
      this.logger.log(`Job queued due to max concurrent limit: ${itemId}/${qualityHash}`);
    }

    this.logger.log(
      `Started new optimization for ${itemId}/${qualityHash} -> job ${jobId}`
    );

    return jobId;
  }

  getJobStatus(jobId: string): Job | null {
    // Get job mapping to find the corresponding cache item
    const mapping = this.jobMappingService.getJobMapping(jobId);

    if (!mapping) {
      this.logger.warn(`Job mapping not found for jobId: ${jobId}`);
      return null;
    }

    // Get cache item
    const cacheItem = this.cacheService.getCacheItem(mapping.itemId, mapping.qualityHash);

    if (!cacheItem) {
      this.logger.warn(`Cache item not found for ${mapping.itemId}/${mapping.qualityHash}`);
      return null;
    }

    // Check processing job status vs cache item status
    const processingKey = `${mapping.itemId}_${mapping.qualityHash}`;
    const processingJob = this.processingJobs.get(processingKey);

    // Convert cache item to Job format for backward compatibility
    let job = this.convertCacheItemToJob(cacheItem, jobId, mapping.deviceId);

    // Override job status with processing job status if it's queued
    if (processingJob && processingJob.status === 'queued') {
      job.status = 'queued';
    }

    return job;
  }

  getAllJobs(deviceId?: string | null): Job[] {
    const jobs: Job[] = [];

    // Get all job mappings for the device (or all if no deviceId specified)
    const mappings = deviceId
      ? this.jobMappingService.getJobMappingsForDevice(deviceId)
      : this.jobMappingService.getAllJobMappings();

    for (const mapping of mappings) {
      const cacheItem = this.cacheService.getCacheItem(mapping.itemId, mapping.qualityHash);
      if (cacheItem) {
        const job = this.convertCacheItemToJob(cacheItem, mapping.jobId, mapping.deviceId);

        // Include active jobs (exclude downloaded and cancelled jobs like original)
        if (mapping.status === 'active') {
          jobs.push(job);
        }
      }
    }

    return jobs;
  }

  async deleteCache(): Promise<{ message: string }> {
    try {
      let deletedItems = 0;
      let deletedMappings = 0;

      // Get all cache items and remove them properly
      const allMappings = this.jobMappingService.getAllJobMappings();
      const processedItems = new Set<string>();

      for (const mapping of allMappings) {
        const itemKey = `${mapping.itemId}_${mapping.qualityHash}`;

        if (!processedItems.has(itemKey)) {
          const success = await this.cacheService.removeItem(mapping.itemId, mapping.qualityHash);
          if (success) {
            deletedItems++;
          }
          processedItems.add(itemKey);
        }

        // Remove job mapping
        await this.jobMappingService.removeJobMapping(mapping.jobId);
        deletedMappings++;
      }

      // Clear in-memory collections
      this.processingJobs.clear();
      this.ffmpegProcesses.clear();
      this.videoDurations.clear();

      // Also clean up any remaining legacy files
      try {
        const files = await fsPromises.readdir(this.cacheDir);
        const legacyFiles = files.filter(file => file.startsWith('combined_') && file.endsWith('.mp4'));

        await Promise.all(
          legacyFiles.map((file) => fsPromises.unlink(path.join(this.cacheDir, file)))
        );

        if (legacyFiles.length > 0) {
          this.logger.log(`Cleaned up ${legacyFiles.length} legacy cache files`);
        }
      } catch (error) {
        this.logger.warn(`Error cleaning legacy files: ${error.message}`);
      }

      this.logger.log(`Cache deletion completed: ${deletedItems} items, ${deletedMappings} job mappings`);

      return {
        message: `Cache deleted successfully: ${deletedItems} items, ${deletedMappings} job mappings`,
      };
    } catch (error) {
      this.logger.error('Error deleting cache:', error);
      throw new InternalServerErrorException('Failed to delete cache');
    }
  }



  async cancelJob(jobId: string): Promise<boolean> {
    // Get job mapping to find the corresponding cache item
    const mapping = this.jobMappingService.getJobMapping(jobId);

    if (!mapping) {
      this.logger.warn(`Job mapping not found for jobId: ${jobId}`);
      return false;
    }

    // Get cache item
    const cacheItem = this.cacheService.getCacheItem(mapping.itemId, mapping.qualityHash);

    if (!cacheItem) {
      this.logger.warn(`Cache item not found for ${mapping.itemId}/${mapping.qualityHash}`);
      return false;
    }

    // Find the FFmpeg process for this cache item
    const processKey = `${mapping.itemId}_${mapping.qualityHash}`;
    const process = this.ffmpegProcesses.get(processKey);

    const finalizeJobCancellation = async () => {
      // Mark job as cancelled instead of removing it
      await this.jobMappingService.updateJobStatus(jobId, 'cancelled');

      // Remove device from waiting list
      await this.cacheService.removeWaitingDevice(mapping.itemId, mapping.qualityHash, mapping.deviceId);

      // If no more devices are waiting and status is processing, mark as failed and remove processing lock
      const updatedCacheItem = this.cacheService.getCacheItem(mapping.itemId, mapping.qualityHash);
      if (updatedCacheItem && updatedCacheItem.waitingDevices.length === 0 && updatedCacheItem.status === 'processing') {
        await this.cacheService.updateCacheItemStatus(
          mapping.itemId,
          mapping.qualityHash,
          'failed',
          { error: 'Cancelled by user' }
        );

        // Remove processing lock
        await this.cacheService.removeProcessingLock(mapping.itemId, mapping.qualityHash);
      }

      this.logger.log(`Job ${jobId} cancelled successfully`);
    };

    if (process && cacheItem.status === 'processing') {
      try {
        this.logger.log(`Attempting to kill process tree for PID ${process.pid}`);

        // Kill the process and wait for completion
        await new Promise<void>((resolve, reject) => {
          kill(process.pid, 'SIGINT', (err) => {
            if (err) {
              this.logger.error(`Failed to kill process tree for PID ${process.pid}: ${err.message}`);
              reject(err);
            } else {
              this.logger.log(`Successfully killed process tree for PID ${process.pid}`);
              resolve();
            }
          });
        });

        // Clean up after successful kill
        this.ffmpegProcesses.delete(processKey);
        this.videoDurations.delete(processKey);

        // Remove processing job
        const processingKey = `${mapping.itemId}_${mapping.qualityHash}`;
        this.processingJobs.delete(processingKey);

        // Finalize cancellation
        await finalizeJobCancellation();

        // Check if we can start any queued jobs
        this.checkAndStartQueuedJobs();

        return true;
      } catch (err) {
        this.logger.error(`Error terminating process for job ${jobId}: ${err.message}`);

        // Even if kill failed, still try to clean up
        this.ffmpegProcesses.delete(processKey);
        this.videoDurations.delete(processKey);
        this.processingJobs.delete(processKey);

        await finalizeJobCancellation();
        return false;
      }
    } else {
      // No active process, just finalize cancellation
      await finalizeJobCancellation();
      return true;
    }
  }


  async getTranscodedFilePath(jobId: string): Promise<string | null> {
    // Get job mapping to find the corresponding cache item
    const mapping = this.jobMappingService.getJobMapping(jobId);

    if (!mapping) {
      return null;
    }

    // Get cache item
    const cacheItem = this.cacheService.getCacheItem(mapping.itemId, mapping.qualityHash);

    if (cacheItem?.status === 'completed') {
      // Update last accessed time when file is downloaded (but don't change job status)
      await this.cacheService.updateLastAccessed(mapping.itemId, mapping.qualityHash);

      this.logger.log(`Download started for ${cacheItem.filePath}`);
      return cacheItem.filePath;
    }

    return null;
  }

  getMaxConcurrentJobs(): number {
    return this.maxConcurrentJobs;
  }

  async getStatistics() {
    // Get new cache system statistics
    const cacheStats = this.cacheService.getCacheStats();
    const jobMappingStats = this.jobMappingService.getStats();

    // Calculate cache size from new system
    const cacheSize = this.formatSize(cacheStats.totalSize);

    // Use new cache system data
    const totalTranscodes = cacheStats.completedJobs + cacheStats.failedJobs;
    const activeJobs = cacheStats.activeProcessingJobs;
    const completedJobs = cacheStats.completedJobs;

    // Get unique devices from job mappings
    const uniqueDevices = Object.keys(jobMappingStats.byDevice).length;

    return {
      cacheSize,
      totalTranscodes,
      activeJobs,
      completedJobs,
      uniqueDevices,
      // Additional new system stats
      cacheStats: {
        totalItems: cacheStats.totalItems,
        totalQualities: cacheStats.totalQualities,
        itemsReadyForCleanup: cacheStats.itemsReadyForCleanup,
        oldestItem: cacheStats.oldestItem,
        newestItem: cacheStats.newestItem,
      },
      jobMappingStats: {
        totalMappings: jobMappingStats.total,
        deviceBreakdown: jobMappingStats.byDevice,
        oldestMapping: jobMappingStats.oldestMapping,
      },
    };
  }

  async getDashboardStats() {
    const cacheStats = this.cacheService.getCacheStats();
    const jobMappingStats = this.jobMappingService.getStats();

    // Get current jobs for dashboard
    const currentJobs = this.getAllJobs().map(job => ({
      id: job.id,
      title: this.getJobTitle(job),
      status: job.status,
      statusText: this.getStatusText(job.status),
      progress: Math.round(job.progress || 0),
      speed: job.speed ? `${job.speed.toFixed(1)}` : '0.0',
    }));

    // Get cached items for browser
    const cachedItems = await this.getCachedItemsForDashboard();

    // Calculate uptime
    const uptimeMs = process.uptime() * 1000;
    const uptime = this.formatUptime(uptimeMs);

    // Get queue length
    const queueLength = Array.from(this.processingJobs.values()).filter(
      job => job.status === 'queued'
    ).length;

    return {
      system: {
        uptime,
        activeJobs: cacheStats.activeProcessingJobs,
        queueLength,
        maxConcurrent: this.maxConcurrentJobs,
      },
      cache: {
        totalItems: cacheStats.totalItems,
        totalSize: this.formatSize(cacheStats.totalSize),
        oldestItem: cacheStats.oldestItem ? this.formatTimeAgo(cacheStats.oldestItem) : 'None',
        readyForCleanup: cacheStats.itemsReadyForCleanup,
      },
      stats: {
        totalTranscodes: cacheStats.completedJobs + cacheStats.failedJobs,
        completedJobs: cacheStats.completedJobs,
        failedJobs: cacheStats.failedJobs,
        uniqueDevices: Object.keys(jobMappingStats.byDevice).length,
      },
      cleanup: {
        retentionHours: 48, // From config
        lastCleanup: 'Unknown', // TODO: Track last cleanup time
        nextCleanup: 'Next hour', // TODO: Calculate next cleanup
        itemsCleanedToday: 0, // TODO: Track daily cleanup count
      },
      jobs: currentJobs,
      cachedItems: cachedItems,
    };
  }

  private async getCachedItemsForDashboard() {
    const allCacheItems = this.cacheService.getAllCacheItems();

    // Convert cache items to dashboard format
    const items = allCacheItems.map(cacheItem => {
      const title = this.getCacheItemTitle(cacheItem);
      const type = this.getCacheItemType(cacheItem);
      const quality = this.getCacheItemQuality(cacheItem);

      return {
        id: cacheItem.itemId,
        title,
        type,
        quality,
        status: cacheItem.status,
        statusText: this.getStatusText(cacheItem.status),
        progress: Math.round(cacheItem.progress || 0),
        size: cacheItem.size ? this.formatSize(cacheItem.size) : '0 B',
        createdAt: cacheItem.createdAt,
        lastAccessed: cacheItem.lastAccessed,
        timeAgo: this.formatTimeAgo(cacheItem.lastAccessed),
        error: cacheItem.error,
      };
    });

    // Sort by last accessed (most recent first)
    items.sort((a, b) => b.lastAccessed.getTime() - a.lastAccessed.getTime());

    // Limit to top 20 items for dashboard
    return items.slice(0, 20);
  }

  private getCacheItemTitle(cacheItem: any): string {
    const metadata = cacheItem.metadata;

    if (!metadata) {
      return `Item ${cacheItem.itemId.substring(0, 8)}...`;
    }

    // TV Show Episode
    if (metadata.Type === 'Episode' && metadata.SeriesName) {
      const season = metadata.ParentIndexNumber || 1;
      const episode = metadata.IndexNumber || 1;
      const episodeName = metadata.Name || '';
      return `${metadata.SeriesName} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}${episodeName ? ` - ${episodeName}` : ''}`;
    }

    // Movie
    if (metadata.Type === 'Movie' && metadata.Name) {
      const year = metadata.ProductionYear ? ` (${metadata.ProductionYear})` : '';
      return `${metadata.Name}${year}`;
    }

    // Fallback to Name or itemId
    return metadata.Name || `Item ${cacheItem.itemId.substring(0, 8)}...`;
  }

  private getCacheItemType(cacheItem: any): string {
    const metadata = cacheItem.metadata;

    if (!metadata?.Type) {
      return 'Unknown';
    }

    const typeMap = {
      'Episode': 'TV Show',
      'Movie': 'Movie',
      'Series': 'TV Show',
      'Season': 'TV Season',
    };

    return typeMap[metadata.Type] || metadata.Type;
  }

  private getCacheItemQuality(cacheItem: any): string {
    const qualityInfo = cacheItem.qualityInfo;

    if (!qualityInfo) {
      return 'Unknown Quality';
    }

    // Build quality string from available info
    const parts = [];

    if (qualityInfo.resolution) {
      parts.push(qualityInfo.resolution);
    }

    if (qualityInfo.videoCodec) {
      parts.push(qualityInfo.videoCodec.toUpperCase());
    }

    if (qualityInfo.audioCodec) {
      parts.push(qualityInfo.audioCodec.toUpperCase());
    }

    return parts.length > 0 ? parts.join(' • ') : 'Unknown Quality';
  }

  private getJobTitle(job: Job): string {
    // Try to extract meaningful title from item metadata
    if (job.item?.Name) {
      return job.item.Name;
    }
    if (job.item?.SeriesName && job.item?.IndexNumber) {
      return `${job.item.SeriesName} S${job.item.ParentIndexNumber || 1}E${job.item.IndexNumber}`;
    }
    return `Item ${job.itemId.substring(0, 8)}...`;
  }

  private getStatusText(status: string): string {
    const statusMap = {
      'queued': 'Queued',
      'optimizing': 'Optimizing',
      'completed': 'Completed',
      'failed': 'Failed',
      'cancelled': 'Cancelled',
      'pending downloads limit': 'Pending',
      'ready-for-removal': 'Ready for Removal',
    };
    return statusMap[status] || status;
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else {
      return `${minutes}m ${seconds % 60}s`;
    }
  }

  private formatTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else if (diffHours > 0) {
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    } else if (diffMinutes > 0) {
      return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
    } else {
      return 'Just now';
    }
  }

  async manuallyStartJob(jobId: string): Promise<boolean> {
    // Get job mapping to find the corresponding cache item
    const mapping = this.jobMappingService.getJobMapping(jobId);

    if (!mapping) {
      this.logger.warn(`Job mapping not found for jobId: ${jobId}`);
      return false;
    }

    // Get cache item
    const cacheItem = this.cacheService.getCacheItem(mapping.itemId, mapping.qualityHash);

    if (!cacheItem) {
      this.logger.warn(`Cache item not found for ${mapping.itemId}/${mapping.qualityHash}`);
      return false;
    }

    // Check if already processing or completed
    if (cacheItem.status !== 'processing') {
      this.logger.warn(`Cache item ${mapping.itemId}/${mapping.qualityHash} is not in processing state: ${cacheItem.status}`);
      return false;
    }

    // For new cache system, jobs start automatically, so manual start is not needed
    // But we can return true if the job is already processing
    this.logger.log(`Job ${jobId} is already processing (cache-based system)`);
    return true;
  }





  private formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }











  private getFfmpegArgs(inputUrl: string, outputPath: string): string[] {
    return [
      '-i',
      inputUrl,
      '-c',
      'copy', // Copy both video and audio without re-encoding
      '-movflags',
      '+faststart', // Optimize for web streaming
      '-f',
      'mp4', // Force MP4 container
      outputPath,
    ];
  }

  


  /**
   * Convert cache item to Job format for backward compatibility
   */
  private convertCacheItemToJob(cacheItem: CacheItem, jobId: string, deviceId: string): Job {
    return {
      id: jobId,
      status: this.mapCacheStatusToJobStatus(cacheItem.status),
      progress: cacheItem.progress,
      outputPath: cacheItem.filePath,
      inputUrl: cacheItem.originalUrl,
      deviceId: deviceId,
      itemId: cacheItem.itemId,
      timestamp: cacheItem.createdAt,
      size: cacheItem.size || 0, // Default to 0 if size not available yet
      item: cacheItem.metadata,
      speed: cacheItem.speed,
    };
  }

  /**
   * Map cache item status to job status for backward compatibility
   */
  private mapCacheStatusToJobStatus(cacheStatus: CacheItem['status']): Job['status'] {
    switch (cacheStatus) {
      case 'pending':
        return 'queued';
      case 'processing':
        return 'optimizing';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      default:
        return 'queued';
    }
  }

  /**
   * Check if we can start a new job based on concurrent limits
   */
  private canStartNewJob(): boolean {
    const activeJobs = Array.from(this.processingJobs.values()).filter(
      job => job.status === 'processing'
    ).length;

    return activeJobs < this.maxConcurrentJobs;
  }

  /**
   * Check for queued jobs and start them if slots are available
   */
  private checkAndStartQueuedJobs(): void {
    if (!this.canStartNewJob()) {
      return;
    }

    // Find pending jobs that can be started
    const pendingJobs = Array.from(this.processingJobs.entries()).filter(
      ([, job]) => job.status === 'queued'
    );

    for (const [, processingJob] of pendingJobs) {
      if (!this.canStartNewJob()) {
        break;
      }

      const cacheItem = this.cacheService.getCacheItem(processingJob.itemId, processingJob.qualityHash);
      if (cacheItem && cacheItem.status === 'pending') {
        this.logger.log(`Starting queued job: ${processingJob.itemId}/${processingJob.qualityHash}`);

        // Mark as processing immediately to prevent race conditions
        processingJob.status = 'processing';

        this.startOptimizationJob(cacheItem, processingJob).catch(error => {
          this.logger.error(`Failed to start queued optimization job: ${error.message}`);
        });
      }
    }
  }

  /**
   * Start optimization job for cache item
   */
  private async startOptimizationJob(cacheItem: CacheItem, processingJob: ProcessingJob): Promise<void> {
    try {
      // Only set status if not already processing (for race condition prevention)
      if (processingJob.status !== 'processing') {
        processingJob.status = 'processing';
      }
      processingJob.startedAt = new Date();

      // Only update cache item status to 'processing' if we're actually starting the job
      // For queued jobs, we should NOT call this method until they're ready to start
      await this.cacheService.updateCacheItemStatus(
        cacheItem.itemId,
        cacheItem.qualityHash,
        'processing'
      );

      const ffmpegArgs = this.getFfmpegArgs(cacheItem.originalUrl, cacheItem.filePath);

      // Ensure directory exists
      const dir = path.dirname(cacheItem.filePath);
      await fsPromises.mkdir(dir, { recursive: true });

      await this.startFFmpegProcessForCache(cacheItem, processingJob, ffmpegArgs);

    } catch (error) {
      this.logger.error(`Error starting optimization job for ${cacheItem.itemId}/${cacheItem.qualityHash}: ${error.message}`);

      processingJob.status = 'failed';
      processingJob.error = error.message;

      await this.cacheService.updateCacheItemStatus(
        cacheItem.itemId,
        cacheItem.qualityHash,
        'failed',
        { error: error.message }
      );
    }
  }

  /**
   * Start FFmpeg process for cache item
   */
  private async startFFmpegProcessForCache(
    cacheItem: CacheItem,
    processingJob: ProcessingJob,
    ffmpegArgs: string[],
  ): Promise<void> {
    try {
      // Get video duration first
      await this.getVideoDurationForCache(cacheItem.originalUrl, cacheItem.itemId, cacheItem.qualityHash);

      return new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        const processKey = `${cacheItem.itemId}_${cacheItem.qualityHash}`;
        this.ffmpegProcesses.set(processKey, ffmpegProcess);

        ffmpegProcess.stderr.on('data', (data) => {
          this.updateProgressForCache(cacheItem, processingJob, data.toString()).catch(error => {
            this.logger.error(`Error updating progress: ${error.message}`);
          });
        });

        ffmpegProcess.on('close', async (code) => {
          this.ffmpegProcesses.delete(processKey);
          this.videoDurations.delete(processKey);

          if (code === 0) {
            // Success
            processingJob.status = 'completed';
            processingJob.completedAt = new Date();

            await this.cacheService.updateCacheItemStatus(
              cacheItem.itemId,
              cacheItem.qualityHash,
              'completed',
              { progress: 100 }
            );

            this.logger.log(
              `Optimization completed for ${cacheItem.itemId}/${cacheItem.qualityHash}`
            );
            resolve();
          } else {
            // Failed
            const errorMsg = `FFmpeg process failed with exit code ${code}`;
            processingJob.status = 'failed';
            processingJob.error = errorMsg;

            await this.cacheService.updateCacheItemStatus(
              cacheItem.itemId,
              cacheItem.qualityHash,
              'failed',
              { error: errorMsg }
            );

            this.logger.error(
              `Optimization failed for ${cacheItem.itemId}/${cacheItem.qualityHash}: ${errorMsg}`
            );
            reject(new Error(errorMsg));
          }

          // Clean up processing job
          const processingKey = `${cacheItem.itemId}_${cacheItem.qualityHash}`;
          this.processingJobs.delete(processingKey);

          // Check if we can start any queued jobs
          this.checkAndStartQueuedJobs();
        });

        ffmpegProcess.on('error', async (error) => {
          this.logger.error(
            `FFmpeg process error for ${cacheItem.itemId}/${cacheItem.qualityHash}: ${error.message}`
          );

          processingJob.status = 'failed';
          processingJob.error = error.message;

          await this.cacheService.updateCacheItemStatus(
            cacheItem.itemId,
            cacheItem.qualityHash,
            'failed',
            { error: error.message }
          );

          reject(error);
        });
      });
    } catch (error) {
      this.logger.error(`Error processing ${cacheItem.itemId}/${cacheItem.qualityHash}: ${error.message}`);

      processingJob.status = 'failed';
      processingJob.error = error.message;

      await this.cacheService.updateCacheItemStatus(
        cacheItem.itemId,
        cacheItem.qualityHash,
        'failed',
        { error: error.message }
      );

      throw error;
    }
  }

  /**
   * Get video duration for cache item
   */
  private async getVideoDurationForCache(
    inputUrl: string,
    itemId: string,
    qualityHash: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputUrl,
      ]);

      let output = '';

      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(output.trim());
          const key = `${itemId}_${qualityHash}`;
          this.videoDurations.set(key, duration);
          resolve();
        } else {
          reject(new Error(`ffprobe process exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Update progress for cache item
   */
  private async updateProgressForCache(
    cacheItem: CacheItem,
    processingJob: ProcessingJob,
    ffmpegOutput: string,
  ): Promise<void> {
    const progressMatch = ffmpegOutput.match(
      /time=(\d{2}):(\d{2}):(\d{2})\.\d{2}/,
    );
    const speedMatch = ffmpegOutput.match(/speed=(\d+\.?\d*)x/);

    if (progressMatch) {
      const [, hours, minutes, seconds] = progressMatch;
      const currentTime =
        parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);

      const durationKey = `${cacheItem.itemId}_${cacheItem.qualityHash}`;
      const totalDuration = this.videoDurations.get(durationKey);

      if (totalDuration) {
        const progress = Math.min((currentTime / totalDuration) * 100, 99.9);
        processingJob.progress = Math.max(progress, 0);

        // Update speed if available
        if (speedMatch) {
          const speed = parseFloat(speedMatch[1]);
          processingJob.speed = Math.max(speed, 0);
        }

        // Update cache item progress - this will be reflected in all job status calls
        await this.cacheService.updateCacheItemStatus(
          cacheItem.itemId,
          cacheItem.qualityHash,
          'processing',
          {
            progress: processingJob.progress,
            speed: processingJob.speed
          }
        );

        // Log progress occasionally for debugging
        if (Math.floor(processingJob.progress) % 10 === 0) {
          this.logger.debug(
            `Progress update: ${cacheItem.itemId}/${cacheItem.qualityHash} - ${processingJob.progress.toFixed(1)}% (${processingJob.speed}x)`
          );
        }
      }
    }
  }

  /**
   * Perform startup cleanup to handle interrupted jobs
   */
  private async performStartupCleanup(): Promise<void> {
    try {
      this.logger.log('Performing startup cleanup...');

      // Clear any in-memory processing jobs (they're invalid after restart)
      this.processingJobs.clear();
      this.ffmpegProcesses.clear();
      this.videoDurations.clear();

      // Get statistics before cleanup
      const statsBefore = this.cacheService.getCacheStats();
      const interruptedJobs = statsBefore.activeProcessingJobs;

      if (interruptedJobs > 0) {
        this.logger.log(`Found ${interruptedJobs} interrupted jobs from previous session`);

        // Cache service already cleaned up interrupted jobs in its constructor
        // Job mappings for interrupted jobs will be handled by cleanup service

        // Get statistics after cleanup
        const statsAfter = this.cacheService.getCacheStats();
        const cleanedJobs = interruptedJobs - statsAfter.activeProcessingJobs;

        if (cleanedJobs > 0) {
          this.logger.log(`Cleaned up ${cleanedJobs} interrupted jobs`);
        }
      }

      // Auto-resume pending jobs
      await this.autoResumePendingJobs();

      this.logger.log('Startup cleanup completed');
    } catch (error) {
      this.logger.error(`Error during startup cleanup: ${error.message}`);
    }
  }

  /**
   * Auto-resume pending jobs after startup
   */
  private async autoResumePendingJobs(): Promise<void> {
    try {
      const allMappings = this.jobMappingService.getAllJobMappings();
      const pendingJobs: { cacheItem: CacheItem; mappings: any[] }[] = [];

      // Group mappings by cache item
      const itemGroups = new Map<string, any[]>();

      for (const mapping of allMappings) {
        if (mapping.status === 'active') {
          const cacheItem = this.cacheService.getCacheItem(mapping.itemId, mapping.qualityHash);

          if (cacheItem && cacheItem.status === 'pending') {
            const key = `${mapping.itemId}_${mapping.qualityHash}`;

            if (!itemGroups.has(key)) {
              itemGroups.set(key, []);
            }
            itemGroups.get(key)!.push(mapping);
          }
        }
      }

      // Start optimization for each pending cache item
      for (const mappings of itemGroups.values()) {
        const firstMapping = mappings[0];
        const cacheItem = this.cacheService.getCacheItem(firstMapping.itemId, firstMapping.qualityHash);

        if (cacheItem && cacheItem.status === 'pending') {
          pendingJobs.push({ cacheItem, mappings });
        }
      }

      if (pendingJobs.length > 0) {
        this.logger.log(`Auto-resuming ${pendingJobs.length} pending jobs from previous session`);

        // Start jobs with concurrency limit
        let startedCount = 0;
        const maxConcurrent = this.maxConcurrentJobs;

        for (const { cacheItem, mappings } of pendingJobs) {
          if (startedCount >= maxConcurrent) {
            this.logger.log(`Reached max concurrent jobs (${maxConcurrent}), remaining jobs will start when slots become available`);
            break;
          }

          try {
            // Check if already processing (race condition protection)
            const processingKey = `${cacheItem.itemId}_${cacheItem.qualityHash}`;
            if (!this.processingJobs.has(processingKey)) {
              // Create processing job
              const processingJob: ProcessingJob = {
                jobId: mappings[0].jobId, // Use first job ID as primary
                itemId: cacheItem.itemId,
                qualityHash: cacheItem.qualityHash,
                status: 'queued',
                progress: 0,
                deviceIds: mappings.map(m => m.deviceId),
                speed: 0,
                createdAt: new Date(),
              };

              this.processingJobs.set(processingKey, processingJob);

              // Start optimization
              this.startOptimizationJob(cacheItem, processingJob);
              startedCount++;

              this.logger.log(
                `Auto-resumed job: ${cacheItem.itemId}/${cacheItem.qualityHash} (${mappings.length} waiting devices)`
              );
            }
          } catch (error) {
            this.logger.error(
              `Error auto-resuming job ${cacheItem.itemId}/${cacheItem.qualityHash}: ${error.message}`
            );
          }
        }

        if (startedCount > 0) {
          this.logger.log(`Successfully auto-resumed ${startedCount} jobs`);
        }
      } else {
        this.logger.log('No pending jobs found to auto-resume');
      }
    } catch (error) {
      this.logger.error(`Error during auto-resume: ${error.message}`);
    }
  }
}
