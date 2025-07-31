/**
 * Store for managing cleared lines persistence
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileValidationState } from './models.js';
import { Logger } from 'winston';

export interface ClearedLinesStoreDependencies {
  logger: Logger;
}

/**
 * Manages persistence and retrieval of cleared lines data
 */
export class ClearedLinesStore {
  private readonly storePath: string;
  private readonly logger: Logger;
  private cache: Map<string, FileValidationState> = new Map();

  constructor(storePath: string, dependencies: ClearedLinesStoreDependencies) {
    this.storePath = storePath;
    this.logger = dependencies.logger;
  }

  /**
   * Initialize the store and load existing data
   */
  async initialize(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.storePath);
      await fs.mkdir(dir, { recursive: true });

      // Load existing data if file exists
      try {
        const data = await fs.readFile(this.storePath, 'utf-8');
        const parsed = JSON.parse(data) as Record<string, any>;
        
        // Convert to FileValidationState objects
        for (const [filePath, state] of Object.entries(parsed)) {
          this.cache.set(filePath, {
            filePath: state.filePath,
            lastModified: new Date(state.lastModified),
            fileHash: state.fileHash,
            clearedLines: new Set(state.clearedLines),
            totalLines: state.totalLines,
            errors: state.errors?.map((e: any) => ({
              ...e,
              occurredAt: new Date(e.occurredAt)
            })) || []
          });
        }
        
        this.logger.info(`[ClearedLinesStore] Loaded ${this.cache.size} file states from store`);
      } catch (error) {
        if ((error as any).code !== 'ENOENT') {
          throw error;
        }
        this.logger.info('[ClearedLinesStore] No existing store file found, starting fresh');
      }
    } catch (error) {
      this.logger.error('[ClearedLinesStore] Failed to initialize store:', error);
      throw error;
    }
  }

  /**
   * Calculate hash of file content
   */
  private async calculateFileHash(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch (error) {
      this.logger.error(`[ClearedLinesStore] Failed to hash file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Get the validation state for a file
   */
  async getFileState(filePath: string): Promise<FileValidationState | null> {
    const normalized = path.resolve(filePath);
    const cached = this.cache.get(normalized);
    
    if (!cached) {
      return null;
    }

    // Check if file has been modified
    try {
      const stats = await fs.stat(normalized);
      const currentHash = await this.calculateFileHash(normalized);
      
      if (currentHash !== cached.fileHash) {
        this.logger.info(`[ClearedLinesStore] File ${normalized} has been modified, invalidating cleared lines`);
        this.cache.delete(normalized);
        await this.persist();
        return null;
      }
      
      return cached;
    } catch (error) {
      this.logger.error(`[ClearedLinesStore] Failed to check file state for ${normalized}:`, error);
      return null;
    }
  }

  /**
   * Mark a line as cleared
   */
  async markLineCleared(filePath: string, line: number): Promise<void> {
    const normalized = path.resolve(filePath);
    
    let state = this.cache.get(normalized);
    if (!state) {
      // Create new state
      const stats = await fs.stat(normalized);
      const hash = await this.calculateFileHash(normalized);
      const content = await fs.readFile(normalized, 'utf-8');
      const lines = content.split('\n');
      
      state = {
        filePath: normalized,
        lastModified: stats.mtime,
        fileHash: hash,
        clearedLines: new Set(),
        totalLines: lines.length,
        errors: []
      };
      this.cache.set(normalized, state);
    }
    
    state.clearedLines.add(line);
    this.logger.debug(`[ClearedLinesStore] Marked line ${line} as cleared in ${normalized}`);
    
    // Persist periodically (every 10 lines)
    if (state.clearedLines.size % 10 === 0) {
      await this.persist();
    }
  }

  /**
   * Record a validation error
   */
  async recordError(filePath: string, line: number, error: string, stack?: string): Promise<void> {
    const normalized = path.resolve(filePath);
    
    let state = this.cache.get(normalized);
    if (!state) {
      const stats = await fs.stat(normalized);
      const hash = await this.calculateFileHash(normalized);
      const content = await fs.readFile(normalized, 'utf-8');
      const lines = content.split('\n');
      
      state = {
        filePath: normalized,
        lastModified: stats.mtime,
        fileHash: hash,
        clearedLines: new Set(),
        totalLines: lines.length,
        errors: []
      };
      this.cache.set(normalized, state);
    }
    
    state.errors.push({
      file: normalized,
      line,
      error,
      stack,
      occurredAt: new Date()
    });
    
    this.logger.warn(`[ClearedLinesStore] Recorded error at ${normalized}:${line}: ${error}`);
    await this.persist();
  }

  /**
   * Get all cleared lines for a file
   */
  async getClearedLines(filePath: string): Promise<number[]> {
    const state = await this.getFileState(filePath);
    return state ? Array.from(state.clearedLines).sort((a, b) => a - b) : [];
  }

  /**
   * Check if a line has been cleared
   */
  async isLineCleared(filePath: string, line: number): Promise<boolean> {
    const state = await this.getFileState(filePath);
    return state ? state.clearedLines.has(line) : false;
  }

  /**
   * Get statistics about validation progress
   */
  async getStatistics(): Promise<{
    totalFiles: number;
    totalClearedLines: number;
    totalErrors: number;
    fileProgress: Array<{ file: string; cleared: number; total: number; percentage: number }>;
  }> {
    const fileProgress = Array.from(this.cache.entries()).map(([file, state]) => ({
      file,
      cleared: state.clearedLines.size,
      total: state.totalLines,
      percentage: Math.round((state.clearedLines.size / state.totalLines) * 100)
    }));

    const totalClearedLines = fileProgress.reduce((sum, f) => sum + f.cleared, 0);
    const totalErrors = Array.from(this.cache.values()).reduce((sum, state) => sum + state.errors.length, 0);

    return {
      totalFiles: this.cache.size,
      totalClearedLines,
      totalErrors,
      fileProgress: fileProgress.sort((a, b) => b.percentage - a.percentage)
    };
  }

  /**
   * Persist the cache to disk
   */
  async persist(): Promise<void> {
    try {
      const data: Record<string, any> = {};
      
      for (const [filePath, state] of this.cache.entries()) {
        data[filePath] = {
          filePath: state.filePath,
          lastModified: state.lastModified.toISOString(),
          fileHash: state.fileHash,
          clearedLines: Array.from(state.clearedLines),
          totalLines: state.totalLines,
          errors: state.errors.map(e => ({
            ...e,
            occurredAt: e.occurredAt.toISOString()
          }))
        };
      }
      
      await fs.writeFile(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
      this.logger.debug('[ClearedLinesStore] Persisted cache to disk');
    } catch (error) {
      this.logger.error('[ClearedLinesStore] Failed to persist cache:', error);
      throw error;
    }
  }

  /**
   * Clear all data
   */
  async clear(): Promise<void> {
    this.cache.clear();
    await this.persist();
    this.logger.info('[ClearedLinesStore] Cleared all validation data');
  }
}