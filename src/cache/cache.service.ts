import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fsPromises } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import { CACHE_DIR } from '../constants';
import { CacheItem, ItemInfo, CacheStats } from './interfaces/cache-item.interface';
import { QualityInfo } from './interfaces/quality-info.interface';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private cacheItems: Map<string, CacheItem> = new Map();
  private itemsDir: string;
  private readonly cancelInterruptedJobs: boolean;

  constructor(private readonly configService: ConfigService) {
    this.itemsDir = path.join(CACHE_DIR, 'items');
    this.cancelInterruptedJobs = this.configService.get<boolean>('CANCEL_INTERRUPTED_JOBS', false);
    this.ensureDirectoryStructure();
    this.loadExistingCacheItems();
    this.cleanupInterruptedJobs();
  }

  /**
   * Get cache item by itemId and qualityHash
   */
  getCacheItem(itemId: string, qualityHash: string): CacheItem | null {
    const key = this.getCacheKey(itemId, qualityHash);
    return this.cacheItems.get(key) || null;
  }

  /**
   * Create a new cache item
   */
  async createCacheItem(
    itemId: string, 
    qualityHash: string, 
    qualityInfo: QualityInfo, 
    originalUrl: string,
    metadata?: any
  ): Promise<CacheItem> {
    const key = this.getCacheKey(itemId, qualityHash);
    const filePath = this.generateFilePath(itemId, qualityHash);
    
    const cacheItem: CacheItem = {
      itemId,
      qualityHash,
      qualityInfo,
      status: 'pending', // Start with pending, will be updated to processing when job actually starts
      filePath,
      createdAt: new Date(),
      lastAccessed: new Date(),
      size: 0,
      originalUrl,
      waitingDevices: [],
      metadata,
      progress: 0,
    };

    this.cacheItems.set(key, cacheItem);
    
    // Create directory structure and processing lock
    await this.ensureItemDirectory(itemId, qualityHash);
    await this.createProcessingLock(itemId, qualityHash);
    await this.saveCacheItemToDisk(cacheItem);
    
    this.logger.debug(`Created cache item: ${key}`);
    return cacheItem;
  }

  /**
   * Update cache item status
   */
  async updateCacheItemStatus(
    itemId: string, 
    qualityHash: string, 
    status: CacheItem['status'],
    additionalData?: Partial<CacheItem>
  ): Promise<void> {
    const key = this.getCacheKey(itemId, qualityHash);
    const cacheItem = this.cacheItems.get(key);
    
    if (cacheItem) {
      cacheItem.status = status;
      
      if (additionalData) {
        Object.assign(cacheItem, additionalData);
      }
      
      if (status === 'completed') {
        cacheItem.completedAt = new Date();
        cacheItem.progress = 100;
        await this.removeProcessingLock(itemId, qualityHash);
        
        // Update file size
        try {
          const stats = await fsPromises.stat(cacheItem.filePath);
          cacheItem.size = stats.size;
        } catch (error) {
          this.logger.error(`Error getting file size for ${key}: ${error.message}`);
        }
      }
      
      if (status === 'failed') {
        await this.removeProcessingLock(itemId, qualityHash);
      }
      
      await this.saveCacheItemToDisk(cacheItem);
      this.logger.debug(`Updated cache item ${key} status to ${status}`);
    }
  }

  /**
   * Update last accessed time
   */
  async updateLastAccessed(itemId: string, qualityHash: string): Promise<void> {
    const key = this.getCacheKey(itemId, qualityHash);
    const cacheItem = this.cacheItems.get(key);
    
    if (cacheItem) {
      cacheItem.lastAccessed = new Date();
      await this.saveCacheItemToDisk(cacheItem);
    }
  }

  /**
   * Add device to waiting list
   */
  async addWaitingDevice(itemId: string, qualityHash: string, deviceId: string): Promise<void> {
    const key = this.getCacheKey(itemId, qualityHash);
    const cacheItem = this.cacheItems.get(key);
    
    if (cacheItem && !cacheItem.waitingDevices.includes(deviceId)) {
      cacheItem.waitingDevices.push(deviceId);
      await this.saveCacheItemToDisk(cacheItem);
      this.logger.debug(`Added device ${deviceId} to waiting list for ${key}`);
    }
  }

  /**
   * Remove device from waiting list
   */
  async removeWaitingDevice(itemId: string, qualityHash: string, deviceId: string): Promise<void> {
    const key = this.getCacheKey(itemId, qualityHash);
    const cacheItem = this.cacheItems.get(key);
    
    if (cacheItem) {
      cacheItem.waitingDevices = cacheItem.waitingDevices.filter(id => id !== deviceId);
      await this.saveCacheItemToDisk(cacheItem);
    }
  }

  /**
   * Get all cache items for an itemId
   */
  getCacheItemsForItem(itemId: string): CacheItem[] {
    const items: CacheItem[] = [];
    
    for (const cacheItem of this.cacheItems.values()) {
      if (cacheItem.itemId === itemId) {
        items.push(cacheItem);
      }
    }
    
    return items;
  }

  /**
   * Get items older than specified timestamp
   */
  getItemsOlderThan(timestamp: number): CacheItem[] {
    const items: CacheItem[] = [];
    
    for (const cacheItem of this.cacheItems.values()) {
      if (cacheItem.lastAccessed.getTime() < timestamp) {
        items.push(cacheItem);
      }
    }
    
    return items;
  }

  /**
   * Remove cache item and associated files
   */
  async removeItem(itemId: string, qualityHash: string): Promise<boolean> {
    const key = this.getCacheKey(itemId, qualityHash);
    const cacheItem = this.cacheItems.get(key);
    
    if (cacheItem) {
      try {
        // Remove video file
        if (fs.existsSync(cacheItem.filePath)) {
          await fsPromises.unlink(cacheItem.filePath);
        }
        
        // Remove metadata file
        const metadataPath = this.getMetadataPath(itemId, qualityHash);
        if (fs.existsSync(metadataPath)) {
          await fsPromises.unlink(metadataPath);
        }
        
        // Remove processing lock if exists
        await this.removeProcessingLock(itemId, qualityHash);
        
        // Remove from memory
        this.cacheItems.delete(key);
        
        // Try to remove empty directories
        await this.cleanupEmptyDirectories(itemId, qualityHash);
        
        this.logger.log(`Removed cache item: ${key}`);
        return true;
      } catch (error) {
        this.logger.error(`Error removing cache item ${key}: ${error.message}`);
        return false;
      }
    }
    
    return false;
  }

  /**
   * Generate cache key
   */
  private getCacheKey(itemId: string, qualityHash: string): string {
    return `${itemId}_${qualityHash}`;
  }

  /**
   * Generate file path for cache item
   */
  private generateFilePath(itemId: string, qualityHash: string): string {
    return path.join(this.itemsDir, itemId, 'qualities', qualityHash, 'video.mp4');
  }

  /**
   * Get metadata file path
   */
  private getMetadataPath(itemId: string, qualityHash: string): string {
    return path.join(this.itemsDir, itemId, 'qualities', qualityHash, 'metadata.json');
  }

  /**
   * Get processing lock file path
   */
  private getProcessingLockPath(itemId: string, qualityHash: string): string {
    return path.join(this.itemsDir, itemId, 'qualities', qualityHash, '.processing');
  }

  /**
   * Create processing lock file
   */
  private async createProcessingLock(itemId: string, qualityHash: string): Promise<void> {
    try {
      const lockPath = this.getProcessingLockPath(itemId, qualityHash);
      await fsPromises.writeFile(lockPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        itemId,
        qualityHash
      }));
    } catch (error) {
      this.logger.error(`Error creating processing lock for ${itemId}/${qualityHash}: ${error.message}`);
    }
  }

  /**
   * Remove processing lock file
   */
  async removeProcessingLock(itemId: string, qualityHash: string): Promise<void> {
    try {
      const lockPath = this.getProcessingLockPath(itemId, qualityHash);
      if (fs.existsSync(lockPath)) {
        await fsPromises.unlink(lockPath);
      }
    } catch (error) {
      this.logger.error(`Error removing processing lock for ${itemId}/${qualityHash}: ${error.message}`);
    }
  }

  /**
   * Ensure item directory structure exists
   */
  private async ensureItemDirectory(itemId: string, qualityHash: string): Promise<void> {
    try {
      const qualityDir = path.join(this.itemsDir, itemId, 'qualities', qualityHash);
      await fsPromises.mkdir(qualityDir, { recursive: true });
    } catch (error) {
      this.logger.error(`Error creating directory for ${itemId}/${qualityHash}: ${error.message}`);
    }
  }

  /**
   * Save cache item metadata to disk
   */
  private async saveCacheItemToDisk(cacheItem: CacheItem): Promise<void> {
    try {
      const metadataPath = this.getMetadataPath(cacheItem.itemId, cacheItem.qualityHash);
      await fsPromises.writeFile(metadataPath, JSON.stringify(cacheItem, null, 2));
    } catch (error) {
      this.logger.error(`Error saving cache item ${cacheItem.itemId}/${cacheItem.qualityHash}: ${error.message}`);
    }
  }

  /**
   * Load existing cache items from disk
   */
  private async loadExistingCacheItems(): Promise<void> {
    try {
      if (!fs.existsSync(this.itemsDir)) {
        return;
      }

      const itemDirs = await fsPromises.readdir(this.itemsDir);

      for (const itemId of itemDirs) {
        const itemPath = path.join(this.itemsDir, itemId);
        const qualitiesPath = path.join(itemPath, 'qualities');

        if (fs.existsSync(qualitiesPath)) {
          const qualityDirs = await fsPromises.readdir(qualitiesPath);

          for (const qualityHash of qualityDirs) {
            try {
              const metadataPath = path.join(qualitiesPath, qualityHash, 'metadata.json');

              if (fs.existsSync(metadataPath)) {
                const content = await fsPromises.readFile(metadataPath, 'utf-8');
                const cacheItem: CacheItem = JSON.parse(content);

                // Convert date strings back to Date objects
                cacheItem.createdAt = new Date(cacheItem.createdAt);
                cacheItem.lastAccessed = new Date(cacheItem.lastAccessed);
                if (cacheItem.completedAt) {
                  cacheItem.completedAt = new Date(cacheItem.completedAt);
                }

                // Check if processing lock exists (means it was interrupted)
                const lockPath = this.getProcessingLockPath(itemId, qualityHash);
                if (fs.existsSync(lockPath) && cacheItem.status === 'processing') {
                  cacheItem.status = 'failed';
                  cacheItem.error = 'Processing interrupted';
                  await this.removeProcessingLock(itemId, qualityHash);
                }

                const key = this.getCacheKey(itemId, qualityHash);
                this.cacheItems.set(key, cacheItem);
              }
            } catch (error) {
              this.logger.error(`Error loading cache item ${itemId}/${qualityHash}: ${error.message}`);
            }
          }
        }
      }

      this.logger.log(`Loaded ${this.cacheItems.size} existing cache items`);
    } catch (error) {
      this.logger.error(`Error loading cache items: ${error.message}`);
    }
  }

  /**
   * Ensure directory structure exists
   */
  private async ensureDirectoryStructure(): Promise<void> {
    try {
      await fsPromises.mkdir(this.itemsDir, { recursive: true });
    } catch (error) {
      this.logger.error(`Error creating cache directory structure: ${error.message}`);
    }
  }

  /**
   * Clean up empty directories after item removal
   */
  private async cleanupEmptyDirectories(itemId: string, qualityHash: string): Promise<void> {
    try {
      const qualityDir = path.join(this.itemsDir, itemId, 'qualities', qualityHash);
      const qualitiesDir = path.join(this.itemsDir, itemId, 'qualities');
      const itemDir = path.join(this.itemsDir, itemId);

      // Try to remove quality directory
      try {
        await fsPromises.rmdir(qualityDir);
      } catch (error) {
        // Directory not empty or doesn't exist, that's fine
      }

      // Try to remove qualities directory if empty
      try {
        const qualityDirs = await fsPromises.readdir(qualitiesDir);
        if (qualityDirs.length === 0) {
          await fsPromises.rmdir(qualitiesDir);
        }
      } catch (error) {
        // Directory not empty or doesn't exist, that's fine
      }

      // Try to remove item directory if empty
      try {
        const itemContents = await fsPromises.readdir(itemDir);
        if (itemContents.length === 0) {
          await fsPromises.rmdir(itemDir);
        }
      } catch (error) {
        // Directory not empty or doesn't exist, that's fine
      }
    } catch (error) {
      this.logger.error(`Error cleaning up directories for ${itemId}/${qualityHash}: ${error.message}`);
    }
  }

  /**
   * Cleanup interrupted jobs on startup
   */
  private async cleanupInterruptedJobs(): Promise<void> {
    try {
      let resumedCount = 0;
      let failedCount = 0;

      for (const cacheItem of this.cacheItems.values()) {
        // Check if item was processing when server stopped
        if (cacheItem.status === 'processing') {
          // Check if processing lock file exists
          const lockPath = this.getProcessingLockPath(cacheItem.itemId, cacheItem.qualityHash);

          if (fs.existsSync(lockPath)) {
            if (this.cancelInterruptedJobs) {
              // Mark as failed since process was interrupted
              cacheItem.status = 'failed';
              cacheItem.error = 'Server restart interrupted processing';

              // Remove processing lock
              await this.removeProcessingLock(cacheItem.itemId, cacheItem.qualityHash);

              failedCount++;
              this.logger.warn(
                `Marked interrupted job as failed: ${cacheItem.itemId}/${cacheItem.qualityHash}`
              );
            } else {
              // Reset to pending for auto-resume
              cacheItem.status = 'pending';
              cacheItem.progress = 0;
              cacheItem.error = undefined;

              // Remove processing lock (will be recreated when job starts)
              await this.removeProcessingLock(cacheItem.itemId, cacheItem.qualityHash);

              resumedCount++;
              this.logger.log(
                `Reset interrupted job for auto-resume: ${cacheItem.itemId}/${cacheItem.qualityHash}`
              );
            }

            // Save updated status
            await this.saveCacheItemToDisk(cacheItem);
          }
        }
      }

      if (resumedCount > 0) {
        this.logger.log(`Reset ${resumedCount} interrupted jobs for auto-resume on startup`);
      }
      if (failedCount > 0) {
        this.logger.log(`Marked ${failedCount} interrupted jobs as failed on startup`);
      }
      if (resumedCount === 0 && failedCount === 0) {
        this.logger.log('No interrupted jobs found during startup');
      }
    } catch (error) {
      this.logger.error(`Error during startup cleanup: ${error.message}`);
    }
  }

  /**
   * Get all cache items
   */
  getAllCacheItems(): CacheItem[] {
    return Array.from(this.cacheItems.values());
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): CacheStats {
    let totalSize = 0;
    let oldestItem: Date | null = null;
    let newestItem: Date | null = null;
    let activeProcessingJobs = 0;
    let completedJobs = 0;
    let failedJobs = 0;
    let itemsReadyForCleanup = 0;

    const now = new Date();
    const retentionMs = 48 * 60 * 60 * 1000; // 48 hours

    for (const cacheItem of this.cacheItems.values()) {
      totalSize += cacheItem.size;

      // Track oldest and newest
      if (!oldestItem || cacheItem.createdAt < oldestItem) {
        oldestItem = cacheItem.createdAt;
      }
      if (!newestItem || cacheItem.createdAt > newestItem) {
        newestItem = cacheItem.createdAt;
      }

      // Count by status
      switch (cacheItem.status) {
        case 'processing':
          activeProcessingJobs++;
          break;
        case 'completed':
          completedJobs++;
          break;
        case 'failed':
          failedJobs++;
          break;
      }

      // Count items ready for cleanup
      if (now.getTime() - cacheItem.lastAccessed.getTime() > retentionMs) {
        itemsReadyForCleanup++;
      }
    }

    const uniqueItems = new Set();
    for (const cacheItem of this.cacheItems.values()) {
      uniqueItems.add(cacheItem.itemId);
    }

    return {
      totalItems: uniqueItems.size,
      totalQualities: this.cacheItems.size,
      totalSize,
      oldestItem,
      newestItem,
      itemsReadyForCleanup,
      activeProcessingJobs,
      completedJobs,
      failedJobs,
    };
  }
}
