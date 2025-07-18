import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppService } from '../app.service';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { CACHE_DIR } from '../constants';
import { FileRemoval } from './removalUtils';
import { ConfigService } from '@nestjs/config';
import { Job } from '../app.service';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);
  private readonly cacheDir: string;
  private readonly removalDelayMs: number;

  constructor(
    private readonly appService: AppService,
    private readonly fileRemoval: FileRemoval,
    private readonly configService: ConfigService,
  ) {
    this.cacheDir = CACHE_DIR;

    const removalDelayHours = this.configService.get<number>(
      'TIME_TO_KEEP_FILES',
      8, // default to 8 hours
    );
    this.removalDelayMs = removalDelayHours * 60 * 60 * 1000; // Convert hours to milliseconds
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handleCleanup(): Promise<void> {
    const jobs = this.appService.getAllJobs();
    const outputPaths = new Set(jobs.map((job) => job.outputPath));

    if (outputPaths.size === 0) {
      this.logger.log('No files to clean up, skipping cleanup job.');
      return;
    }

    this.logger.log(`Running cleanup job on ${outputPaths.size} files...`);
    this.logger.debug(`Output paths: ${[...outputPaths].join(', ')}`);

    const now = Date.now();

    try {
      const files = await fsPromises.readdir(this.cacheDir);
      this.logger.log(`Found ${files.length} files in cache directory: ${this.cacheDir}`);

      // Filter files not associated with any active job
      const filesToRemove = files.filter((file) => {
        const filePath = path.join(this.cacheDir, file);
        return !outputPaths.has(filePath);
      });

      if (filesToRemove.length > 0) {
        this.logger.log(`Removing ${filesToRemove.length} unassociated files...`);

        // Remove files concurrently
        await Promise.all(
          filesToRemove.map(async (file) => {
            const filePath = path.join(this.cacheDir, file);
            this.logger.log(`Removing ${filePath}, no associated jobs`);
            try {
              await this.fileRemoval.removeFile(filePath);
              this.logger.log(`Successfully removed file: ${filePath}`);
            } catch (error) {
              this.logger.error(`Failed to remove file ${filePath}: ${error.message}`);
            }
          }),
        );
      } else {
        this.logger.log('No unassociated files found for removal.');
      }

      const jobsToCleanup = jobs.filter(
        (job) =>
          this.isOlderThanDelay(job.timestamp, now) && job.status === 'ready-for-removal',
      );

      if (jobsToCleanup.length > 0) {
        this.logger.log(`Cleaning up ${jobsToCleanup.length} jobs...`);

        await Promise.all(
          jobsToCleanup.map(async (job) => {
            this.logger.log(`Cleaning up job ${job.id} (timestamp: ${job.timestamp})`);
            try {
              await this.fileRemoval.cleanupReadyForRemovalJobs([job]);
              this.appService.removeJob(job.id);
              this.logger.log(`Successfully cleaned up job ${job.id}`);
            } catch (error) {
              this.logger.error(`Failed to clean up job ${job.id}: ${error.message}`);
            }
          }),
        );
      } else {
        this.logger.log('No jobs eligible for cleanup at this time.');
      }
    } catch (error) {
      this.logger.error(`Error during cleanup process: ${error.message}`);
    }
  }

  /**
   * Determines if the given timestamp is older than the configured delay.
   * @param timestamp The timestamp to compare.
   * @param now The current time in milliseconds.
   * @returns True if the timestamp is older than the delay, else false.
   */
  private isOlderThanDelay(timestamp: Date, now: number): boolean {
    const timestampMs = timestamp.getTime();
    return now - timestampMs > this.removalDelayMs;
  }
}
