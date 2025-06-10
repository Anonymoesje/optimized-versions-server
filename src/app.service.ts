import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
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
  // Legacy job system (for backward compatibility during transition)
  private activeJobs: Job[] = [];
  private optimizationHistory: Job[] = [];
  private ffmpegProcesses: Map<string, ChildProcess> = new Map();
  private videoDurations: Map<string, number> = new Map();
  private jobQueue: string[] = [];

  // New cache-based system
  private processingJobs: Map<string, ProcessingJob> = new Map(); // itemId_qualityHash -> ProcessingJob

  private maxConcurrentJobs: number;
  private maxCachedPerUser: number;
  private cacheDir: string;
  private immediateRemoval: boolean;

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
    this.maxCachedPerUser = this.configService.get<number>(
      'MAX_CACHED_PER_USER',
      10,
    );
    this.immediateRemoval = this.configService.get<boolean>(
      'REMOVE_FILE_AFTER_RIGHT_DOWNLOAD',
      true,
    );
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

    // Start the optimization process (don't await to return jobId immediately)
    this.startOptimizationJob(cacheItem, processingJob).catch(error => {
      this.logger.error(`Failed to start optimization job: ${error.message}`);
    });

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

    // Convert cache item to Job format for backward compatibility
    return this.convertCacheItemToJob(cacheItem, jobId, mapping.deviceId);
  }

  getAllJobs(deviceId?: string | null): Job[] {
    const jobs: Job[] = [];

    // Get all job mappings for the device (or all if no deviceId specified)
    const mappings = deviceId
      ? this.jobMappingService.getJobMappingsForDevice(deviceId)
      : this.jobMappingService.getAllJobMappings();

    for (const mapping of mappings) {
      // Only show active jobs (not downloaded or cancelled)
      if (mapping.status !== 'active') {
        continue;
      }

      const cacheItem = this.cacheService.getCacheItem(mapping.itemId, mapping.qualityHash);
      if (cacheItem && cacheItem.status !== 'failed') {
        const job = this.convertCacheItemToJob(cacheItem, mapping.jobId, mapping.deviceId);
        jobs.push(job);
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



  cancelJob(jobId: string): boolean {
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

      // If no more devices are waiting and status is processing, mark as failed
      const updatedCacheItem = this.cacheService.getCacheItem(mapping.itemId, mapping.qualityHash);
      if (updatedCacheItem && updatedCacheItem.waitingDevices.length === 0 && updatedCacheItem.status === 'processing') {
        await this.cacheService.updateCacheItemStatus(
          mapping.itemId,
          mapping.qualityHash,
          'failed',
          { error: 'Cancelled by user' }
        );
      }

      this.logger.log(`Job ${jobId} cancelled successfully`);
    };

    if (process && cacheItem.status === 'processing') {
      try {
        this.logger.log(`Attempting to kill process tree for PID ${process.pid}`);
        new Promise<void>((resolve, reject) => {
          kill(process.pid, 'SIGINT', (err) => {
            if (err) {
              this.logger.error(`Failed to kill process tree for PID ${process.pid}: ${err.message}`);
              reject(err);
            } else {
              this.logger.log(`Successfully killed process tree for PID ${process.pid}`);
              resolve();
              finalizeJobCancellation();
            }
          });
        });
      } catch (err) {
        this.logger.error(`Error terminating process for job ${jobId}: ${err.message}`);
      }

      this.ffmpegProcesses.delete(processKey);
      this.videoDurations.delete(processKey);

      // Remove processing job
      const processingKey = `${mapping.itemId}_${mapping.qualityHash}`;
      this.processingJobs.delete(processingKey);

      return true;
    } else {
      finalizeJobCancellation();
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
      // Mark job as downloaded
      await this.jobMappingService.updateJobStatus(jobId, 'downloaded');

      // Update last accessed time when file is downloaded
      await this.cacheService.updateLastAccessed(mapping.itemId, mapping.qualityHash);

      this.logger.log(`Job ${jobId} marked as downloaded for ${mapping.itemId}/${mapping.qualityHash}`);
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

  private async getCacheSize(): Promise<string> {
    const cacheSize = await this.getDirectorySize(this.cacheDir);
    return this.formatSize(cacheSize);
  }

  private async getDirectorySize(directory: string): Promise<number> {
    const files = await fs.promises.readdir(directory);
    const stats = await Promise.all(
      files.map((file) => fs.promises.stat(path.join(directory, file))),
    );

    return stats.reduce((accumulator, { size }) => accumulator + size, 0);
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



  private isDeviceIdInOptimizeHistory(job:Job){
    const uniqueDeviceIds: string[] = [...new Set(this.optimizationHistory.map((job: Job) => job.deviceId))];
    const result = uniqueDeviceIds.includes(job.deviceId); // Check if job.deviceId is in uniqueDeviceIds
    this.logger.log(`Device ID ${job.deviceId} is ${result ? 'in' : 'not in'} the finished jobs. Optimizing ${result ? 'Allowed' : 'not Allowed'}`);
    return result
  }

  private getActiveJobDeviceIds(): string[]{
    const uniqueDeviceIds: string[] = [
      ...new Set(
        this.activeJobs
          .filter((job: Job) => job.status === 'queued') // Filter jobs with status 'queued'
          .map((job: Job) => job.deviceId) // Extract deviceId
      )
    ];
    return uniqueDeviceIds
  }
  
  private handleOptimizationHistory(job: Job): void{
    // create a finished jobs list to make sure every device gets equal optimizing time
    this.optimizationHistory.push(job) // push the newest job to the finished jobs list
    const amountOfActiveDeviceIds = this.getActiveJobDeviceIds().length // get the amount of active queued job device ids
    while(amountOfActiveDeviceIds <= this.optimizationHistory.length && this.optimizationHistory.length > 0){ // the finished jobs should always be lower than the amount of active jobs. This is to push out the last deviceid: FIFO
      this.optimizationHistory.shift() // shift away the oldest job.
    }
    this.logger.log(`${this.optimizationHistory.length} deviceIDs have recently finished a job`)
  }



  private checkQueue() {
    let runningJobs = this.activeJobs.filter((job) => job.status === 'optimizing').length;
  
    this.logger.log(
      `${runningJobs} active jobs running and ${this.jobQueue.length} items in the queue`,
    );
  
    for (const index in this.jobQueue) {
      if (runningJobs >= this.maxConcurrentJobs) {
        break; // Stop if max concurrent jobs are reached
      }
      const nextJobId = this.jobQueue[index]; // Access job ID by index
      let nextJob: Job = this.activeJobs.find((job) => job.id === nextJobId);
      
      if (!this.userTooManyCachedItems(nextJobId) ) {
        nextJob.status = 'pending downloads limit'
        // Skip this job if user cache limits are reached
        continue;
      }
      if(this.isDeviceIdInOptimizeHistory(nextJob)){
        // Skip this job if deviceID is in the recently finished jobs
        continue
      }
      // Start the job and remove it from the queue
      this.startJob(nextJobId);
      this.jobQueue.splice(Number(index), 1); // Remove the started job from the queue
      runningJobs++; // Increment running jobs
    }
  }

  private userTooManyCachedItems(jobid): boolean{
    if(this.maxCachedPerUser == 0){
      return false
    }
    const theNewJob: Job = this.activeJobs.find((job) => job.id === jobid)
    let completedUserJobs = this.activeJobs.filter((job) => (job.status === "completed" || job.status === 'optimizing') && job.deviceId === theNewJob.deviceId)
    if((completedUserJobs.length >= this.maxCachedPerUser)){
      this.logger.log(`Waiting for items to be downloaded - device ${theNewJob.deviceId} has ${completedUserJobs.length} downloads waiting `);
      return false
    }
    else{
      this.logger.log(`Optimizing - device ${theNewJob.deviceId} has ${completedUserJobs.length} downloads waiting`);
      return true
    }  
  }

  private startJob(jobId: string) {
    const job = this.activeJobs.find((job) => job.id === jobId);
    if (job) {
      job.status = 'optimizing';
      this.handleOptimizationHistory(job)
      const ffmpegArgs = this.getFfmpegArgs(job.inputUrl, job.outputPath);
      this.startFFmpegProcess(jobId, ffmpegArgs)
        .finally(() => {
          // This runs after the returned Promise resolves or rejects.
          this.checkQueue();
        });
      this.logger.log(`Started job ${jobId}`);
    }
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

  
  private async startFFmpegProcess(
    jobId: string,
    ffmpegArgs: string[],
  ): Promise<void> {
    try {
      await this.getVideoDuration(ffmpegArgs[1], jobId);

      return new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe']});
        this.ffmpegProcesses.set(jobId, ffmpegProcess);

        ffmpegProcess.stderr.on('data', (data) => {
          this.updateProgress(jobId, data.toString());
        });
        
        ffmpegProcess.on('close', async (code) => {
          this.ffmpegProcesses.delete(jobId);
          this.videoDurations.delete(jobId);

          const job = this.activeJobs.find((job) => job.id === jobId);
          if (!job) {
            resolve();
            return;
          }

          if (code === 0) {
            
            job.status = 'completed';
            job.progress = 100;
            // Update the file size
            try {
              const stats = await fsPromises.stat(job.outputPath);
              job.size = stats.size;
            } catch (error) {
              this.logger.error(
                `Error getting file size for job ${jobId}: ${error.message}`,
              );
            }
            this.logger.log(
              `Job ${jobId} completed successfully. Output: ${job.outputPath}, Size: ${this.formatSize(job.size || 0)}`,
            );
            resolve();
          } else {
            job.status = 'failed';
            job.progress = 0;
            this.logger.error(
              `Job ${jobId} failed with exit code ${code}. Input URL: ${job.inputUrl}`,
            );
            // reject(new Error(`FFmpeg process failed with exit code ${code}`));
          }
        });

        ffmpegProcess.on('error', (error) => {
          this.logger.error(
            `FFmpeg process error for job ${jobId}: ${error.message}`,
          );
          // reject(error);
        });
      });
    } catch (error) {
      this.logger.error(`Error processing job ${jobId}: ${error.message}`);
      const job = this.activeJobs.find((job) => job.id === jobId);
      if (job) {
        job.status = 'failed';
      }
    }
  }

  
  private async getVideoDuration(
    inputUrl: string,
    jobId: string,
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
          this.videoDurations.set(jobId, duration);
          resolve();
        } else {
          reject(new Error(`ffprobe process exited with code ${code}`));
        }
      });
    });
  }

  private updateProgress(jobId: string, ffmpegOutput: string): void {
    const progressMatch = ffmpegOutput.match(
      /time=(\d{2}):(\d{2}):(\d{2})\.\d{2}/,
    );
    const speedMatch = ffmpegOutput.match(/speed=(\d+\.?\d*)x/);

    if (progressMatch) {
      const [, hours, minutes, seconds] = progressMatch;
      const currentTime =
        parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);

      const totalDuration = this.videoDurations.get(jobId);
      if (totalDuration) {
        const progress = Math.min((currentTime / totalDuration) * 100, 99.9);
        const job = this.activeJobs.find((job) => job.id === jobId);
        if (job) {
          job.progress = Math.max(progress, 0);

          // Update speed if available
          if (speedMatch) {
            const speed = parseFloat(speedMatch[1]);
            job.speed = Math.max(speed, 0);
          }
        }
      }
    }
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
      size: cacheItem.size,
      item: cacheItem.metadata,
      speed: cacheItem.speed,
    };
  }

  /**
   * Map cache item status to job status for backward compatibility
   */
  private mapCacheStatusToJobStatus(cacheStatus: CacheItem['status']): Job['status'] {
    switch (cacheStatus) {
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
   * Start optimization job for cache item
   */
  private async startOptimizationJob(cacheItem: CacheItem, processingJob: ProcessingJob): Promise<void> {
    try {
      processingJob.status = 'processing';
      processingJob.startedAt = new Date();

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
}
