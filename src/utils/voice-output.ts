/**
 * Voice output utility for macOS 'say' command
 */

import { spawn } from 'child_process';
import { ILogger } from '../interfaces/external-dependencies.js';

export interface VoiceOutputConfig {
  enabled: boolean;
  voice?: string;
  rate?: number;
}

export class VoiceOutput {
  private config: VoiceOutputConfig;
  private logger: ILogger;

  constructor(config: VoiceOutputConfig, logger: ILogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Speak text using macOS 'say' command
   */
  async speak(text: string): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // Skip speaking if on non-macOS platform
    if (process.platform !== 'darwin') {
      this.logger.debug('[VoiceOutput] Skipping voice output on non-macOS platform');
      return;
    }

    return new Promise((resolve, reject) => {
      const args: string[] = [];
      
      // Add voice if specified
      if (this.config.voice) {
        args.push('-v', this.config.voice);
      }
      
      // Add rate if specified
      if (this.config.rate) {
        args.push('-r', this.config.rate.toString());
      }
      
      // Add the text to speak
      args.push(text);
      
      this.logger.debug(`[VoiceOutput] Speaking: "${text}"`);
      
      const sayProcess = spawn('say', args);
      
      sayProcess.on('error', (error) => {
        this.logger.error(`[VoiceOutput] Error running say command: ${error}`);
        reject(error);
      });
      
      sayProcess.on('close', (code) => {
        if (code === 0) {
          this.logger.debug('[VoiceOutput] Finished speaking');
          resolve();
        } else {
          const error = new Error(`say command exited with code ${code}`);
          this.logger.error(`[VoiceOutput] ${error.message}`);
          reject(error);
        }
      });
    });
  }

  /**
   * Speak text asynchronously without waiting for completion
   */
  speakAsync(text: string): void {
    if (!this.config.enabled) {
      return;
    }

    // Skip speaking if on non-macOS platform
    if (process.platform !== 'darwin') {
      return;
    }

    const args: string[] = [];
    
    // Add voice if specified
    if (this.config.voice) {
      args.push('-v', this.config.voice);
    }
    
    // Add rate if specified
    if (this.config.rate) {
      args.push('-r', this.config.rate.toString());
    }
    
    // Add the text to speak
    args.push(text);
    
    this.logger.debug(`[VoiceOutput] Speaking async: "${text}"`);
    
    const sayProcess = spawn('say', args, {
      detached: true,
      stdio: 'ignore'
    });
    
    sayProcess.unref();
  }

  /**
   * Update voice output configuration
   */
  updateConfig(config: Partial<VoiceOutputConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug(`[VoiceOutput] Updated config: ${JSON.stringify(this.config)}`);
  }

  /**
   * Check if voice output is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && process.platform === 'darwin';
  }
}