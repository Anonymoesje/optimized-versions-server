import { Injectable, Logger } from '@nestjs/common';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { CACHE_DIR } from '../constants';
import { JobMapping } from './interfaces/job-mapping.interface';

@Injectable()
export class JobMappingService {
  private readonly logger = new Logger(JobMappingService.name);
  private jobMappings: Map<string, JobMapping> = new Map();
  private jobsDir: string;

  constructor() {
    this.jobsDir = path.join(CACHE_DIR, 'jobs');
    this.ensureJobsDirectory();
    this.loadExistingMappings();
  }

  /**
   * Create a new job mapping
   */
  async createJobMapping(jobId: string, itemId: string, qualityHash: string, deviceId: string): Promise<void> {
    const mapping: JobMapping = {
      jobId,
      itemId,
      qualityHash,
      deviceId,
      createdAt: new Date(),
      lastAccessed: new Date(),
    };

    this.jobMappings.set(jobId, mapping);
    await this.saveJobMappingToDisk(mapping);
    
    this.logger.debug(`Created job mapping: ${jobId} -> ${itemId}/${qualityHash}`);
  }

  /**
   * Get job mapping by jobId
   */
  getJobMapping(jobId: string): JobMapping | null {
    const mapping = this.jobMappings.get(jobId);
    
    if (mapping) {
      // Update last accessed time
      mapping.lastAccessed = new Date();
      this.saveJobMappingToDisk(mapping); // Fire and forget
    }
    
    return mapping || null;
  }

  /**
   * Get all job mappings for a specific item+quality
   */
  getJobMappingsForItem(itemId: string, qualityHash: string): JobMapping[] {
    const mappings: JobMapping[] = [];
    
    for (const mapping of this.jobMappings.values()) {
      if (mapping.itemId === itemId && mapping.qualityHash === qualityHash) {
        mappings.push(mapping);
      }
    }
    
    return mappings;
  }

  /**
   * Get all job mappings for a device
   */
  getJobMappingsForDevice(deviceId: string): JobMapping[] {
    const mappings: JobMapping[] = [];
    
    for (const mapping of this.jobMappings.values()) {
      if (mapping.deviceId === deviceId) {
        mappings.push(mapping);
      }
    }
    
    return mappings;
  }

  /**
   * Remove job mapping
   */
  async removeJobMapping(jobId: string): Promise<boolean> {
    const mapping = this.jobMappings.get(jobId);
    
    if (mapping) {
      this.jobMappings.delete(jobId);
      
      try {
        const filePath = path.join(this.jobsDir, `${jobId}.json`);
        await fsPromises.unlink(filePath);
        this.logger.debug(`Removed job mapping: ${jobId}`);
        return true;
      } catch (error) {
        this.logger.error(`Error removing job mapping file for ${jobId}: ${error.message}`);
      }
    }
    
    return false;
  }

  /**
   * Cleanup orphaned job mappings (jobs without corresponding cache items)
   */
  async cleanupOrphanedMappings(): Promise<number> {
    let cleanedCount = 0;
    const now = new Date();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

    for (const [jobId, mapping] of this.jobMappings.entries()) {
      // Remove mappings older than 7 days
      if (now.getTime() - mapping.lastAccessed.getTime() > maxAge) {
        await this.removeJobMapping(jobId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} orphaned job mappings`);
    }

    return cleanedCount;
  }

  /**
   * Get all job mappings
   */
  getAllJobMappings(): JobMapping[] {
    return Array.from(this.jobMappings.values());
  }

  /**
   * Get statistics about job mappings
   */
  getStats(): { total: number; byDevice: Record<string, number>; oldestMapping: Date | null } {
    const byDevice: Record<string, number> = {};
    let oldestMapping: Date | null = null;

    for (const mapping of this.jobMappings.values()) {
      // Count by device
      byDevice[mapping.deviceId] = (byDevice[mapping.deviceId] || 0) + 1;
      
      // Track oldest mapping
      if (!oldestMapping || mapping.createdAt < oldestMapping) {
        oldestMapping = mapping.createdAt;
      }
    }

    return {
      total: this.jobMappings.size,
      byDevice,
      oldestMapping,
    };
  }

  /**
   * Save job mapping to disk
   */
  private async saveJobMappingToDisk(mapping: JobMapping): Promise<void> {
    try {
      const filePath = path.join(this.jobsDir, `${mapping.jobId}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(mapping, null, 2));
    } catch (error) {
      this.logger.error(`Error saving job mapping ${mapping.jobId}: ${error.message}`);
    }
  }

  /**
   * Load existing job mappings from disk
   */
  private async loadExistingMappings(): Promise<void> {
    try {
      const files = await fsPromises.readdir(this.jobsDir);
      const jsonFiles = files.filter(file => file.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.jobsDir, file);
          const content = await fsPromises.readFile(filePath, 'utf-8');
          const mapping: JobMapping = JSON.parse(content);
          
          // Convert date strings back to Date objects
          mapping.createdAt = new Date(mapping.createdAt);
          mapping.lastAccessed = new Date(mapping.lastAccessed);
          
          this.jobMappings.set(mapping.jobId, mapping);
        } catch (error) {
          this.logger.error(`Error loading job mapping from ${file}: ${error.message}`);
        }
      }

      this.logger.log(`Loaded ${this.jobMappings.size} existing job mappings`);
    } catch (error) {
      this.logger.error(`Error loading job mappings: ${error.message}`);
    }
  }

  /**
   * Ensure jobs directory exists
   */
  private async ensureJobsDirectory(): Promise<void> {
    try {
      await fsPromises.mkdir(this.jobsDir, { recursive: true });
    } catch (error) {
      this.logger.error(`Error creating jobs directory: ${error.message}`);
    }
  }
}
