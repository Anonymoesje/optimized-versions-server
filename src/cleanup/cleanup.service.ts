import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../cache/cache.service';
import { JobMappingService } from '../cache/job-mapping.service';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);
  private readonly retentionMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
    private readonly jobMappingService: JobMappingService,
  ) {

    // Use 48-hour retention policy
    const retentionHours = this.configService.get<number>(
      'CACHE_RETENTION_HOURS',
      48, // default to 48 hours
    );
    this.retentionMs = retentionHours * 60 * 60 * 1000; // Convert hours to milliseconds
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handleCleanup(): Promise<void> {
    this.logger.log('Starting cache cleanup process...');

    const now = new Date();
    const cutoffTime = now.getTime() - this.retentionMs;

    try {
      // Get cache statistics before cleanup
      const statsBefore = this.cacheService.getCacheStats();
      this.logger.log(
        `Cache stats before cleanup: ${statsBefore.totalItems} items, ` +
        `${statsBefore.totalQualities} qualities, ` +
        `${this.formatSize(statsBefore.totalSize)} total size`
      );

      // Get items older than retention period (based on last accessed time)
      const itemsToCleanup = this.cacheService.getItemsOlderThan(cutoffTime);

      if (itemsToCleanup.length > 0) {
        this.logger.log(
          `Found ${itemsToCleanup.length} cache items older than ${this.retentionMs / (60 * 60 * 1000)} hours`
        );

        // Remove old cache items
        let removedCount = 0;
        for (const item of itemsToCleanup) {
          try {
            const success = await this.cacheService.removeItem(item.itemId, item.qualityHash);
            if (success) {
              removedCount++;
              this.logger.debug(
                `Removed cache item: ${item.itemId}/${item.qualityHash} ` +
                `(last accessed: ${item.lastAccessed.toISOString()})`
              );
            }
          } catch (error) {
            this.logger.error(
              `Failed to remove cache item ${item.itemId}/${item.qualityHash}: ${error.message}`
            );
          }
        }

        this.logger.log(`Successfully removed ${removedCount} cache items`);
      } else {
        this.logger.log('No cache items eligible for cleanup');
      }

      // Cleanup orphaned job mappings
      const orphanedMappings = await this.jobMappingService.cleanupOrphanedMappings();
      if (orphanedMappings > 0) {
        this.logger.log(`Cleaned up ${orphanedMappings} orphaned job mappings`);
      }

      // Cleanup old downloaded/cancelled job mappings (older than 24 hours)
      const oldJobMappings = await this.cleanupOldJobMappings();
      if (oldJobMappings > 0) {
        this.logger.log(`Cleaned up ${oldJobMappings} old job mappings`);
      }

      // Get cache statistics after cleanup
      const statsAfter = this.cacheService.getCacheStats();
      this.logger.log(
        `Cache stats after cleanup: ${statsAfter.totalItems} items, ` +
        `${statsAfter.totalQualities} qualities, ` +
        `${this.formatSize(statsAfter.totalSize)} total size`
      );

      // Log space saved
      const spaceSaved = statsBefore.totalSize - statsAfter.totalSize;
      if (spaceSaved > 0) {
        this.logger.log(`Cleanup freed up ${this.formatSize(spaceSaved)} of disk space`);
      }

    } catch (error) {
      this.logger.error(`Error during cleanup process: ${error.message}`);
    }
  }

  /**
   * Cleanup old downloaded/cancelled job mappings
   */
  private async cleanupOldJobMappings(): Promise<number> {
    const now = new Date();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    let cleanedCount = 0;

    const allMappings = this.jobMappingService.getAllJobMappings();

    for (const mapping of allMappings) {
      // Clean up downloaded jobs older than 24 hours
      if (mapping.status === 'downloaded' && mapping.downloadedAt) {
        if (now.getTime() - mapping.downloadedAt.getTime() > maxAge) {
          await this.jobMappingService.removeJobMapping(mapping.jobId);
          cleanedCount++;
        }
      }

      // Clean up cancelled jobs older than 24 hours
      if (mapping.status === 'cancelled') {
        if (now.getTime() - mapping.lastAccessed.getTime() > maxAge) {
          await this.jobMappingService.removeJobMapping(mapping.jobId);
          cleanedCount++;
        }
      }
    }

    return cleanedCount;
  }

  /**
   * Format file size in human readable format
   */
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
}
