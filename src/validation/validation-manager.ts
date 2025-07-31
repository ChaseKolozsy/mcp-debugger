/**
 * Manager for line-by-line code validation
 */
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Logger } from 'winston';
import { SessionManager } from '../session/session-manager.js';
import { ClearedLinesStore } from './cleared-lines-store.js';
import { 
  ValidationConfig, 
  ValidationSession, 
  ValidationResult, 
  ValidationError,
  LineInfo 
} from './models.js';
import { execSync } from 'child_process';
import { ExecutionState } from '../session/models.js';

export interface ValidationManagerDependencies {
  logger: Logger;
  sessionManager: SessionManager;
}

/**
 * Manages line-by-line code validation sessions
 */
export class ValidationManager {
  private readonly logger: Logger;
  private readonly sessionManager: SessionManager;
  private readonly sessions: Map<string, ValidationSession> = new Map();
  private readonly clearedStores: Map<string, ClearedLinesStore> = new Map();

  constructor(dependencies: ValidationManagerDependencies) {
    this.logger = dependencies.logger;
    this.sessionManager = dependencies.sessionManager;
  }

  /**
   * Create a new validation session
   */
  async createSession(config: ValidationConfig): Promise<ValidationSession> {
    const session: ValidationSession = {
      id: uuidv4(),
      config,
      debugSessionId: config.sessionId,
      startedAt: new Date(),
      filesProcessed: new Set(),
      totalLinesValidated: 0,
      errorsFound: [],
      state: 'paused'
    };

    this.sessions.set(session.id, session);

    // Initialize cleared lines store
    const storePath = config.persistencePath || 
      path.join(process.cwd(), '.mcp-debugger', 'cleared-lines.json');
    
    const store = new ClearedLinesStore(storePath, { logger: this.logger });
    await store.initialize();
    this.clearedStores.set(session.id, store);

    this.logger.info(`[ValidationManager] Created validation session ${session.id}`);
    return session;
  }

  /**
   * Start or resume validation
   */
  async startValidation(sessionId: string): Promise<ValidationResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Validation session ${sessionId} not found`);
    }

    const store = this.clearedStores.get(sessionId);
    if (!store) {
      throw new Error(`Cleared lines store for session ${sessionId} not found`);
    }

    session.state = 'running';
    
    try {
      // Start from the configured file and line
      const startFile = session.config.startFile;
      const startLine = session.config.startLine || 1;
      
      await this.validateFile(session, store, startFile, startLine);
      
      session.state = 'completed';
      return {
        success: true,
        session,
        message: 'Validation completed successfully'
      };
    } catch (error) {
      session.state = 'error';
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        success: false,
        session,
        errors: session.errorsFound,
        message: `Validation failed: ${errorMessage}`
      };
    }
  }

  /**
   * Validate a file starting from a specific line
   */
  private async validateFile(
    session: ValidationSession, 
    store: ClearedLinesStore, 
    filePath: string, 
    startLine: number
  ): Promise<void> {
    const normalized = path.resolve(filePath);
    
    if (session.filesProcessed.has(normalized)) {
      this.logger.debug(`[ValidationManager] File ${normalized} already processed, skipping`);
      return;
    }

    session.filesProcessed.add(normalized);
    session.currentFile = normalized;

    // Read file content
    const content = await fs.readFile(normalized, 'utf-8');
    const lines = content.split('\n');

    // Get cleared lines if skipCleared is enabled
    let clearedLines: Set<number> = new Set();
    if (session.config.skipCleared) {
      const cleared = await store.getClearedLines(normalized);
      clearedLines = new Set(cleared);
    }

    // Process each line
    for (let lineNum = startLine; lineNum <= lines.length; lineNum++) {
      if (session.state !== 'running') {
        this.logger.info(`[ValidationManager] Session ${session.id} stopped at line ${lineNum}`);
        break;
      }

      session.currentLine = lineNum;

      // Skip if already cleared
      if (clearedLines.has(lineNum)) {
        this.logger.debug(`[ValidationManager] Skipping cleared line ${normalized}:${lineNum}`);
        continue;
      }

      const lineContent = lines[lineNum - 1];
      const lineInfo = this.analyzeLineWaiting(normalized, lineNum, lineContent);

      // Skip non-executable lines
      if (!this.isExecutableLine(lineInfo)) {
        this.logger.debug(`[ValidationManager] Skipping non-executable line ${normalized}:${lineNum}`);
        continue;
      }

      // In pair mode, speak the line
      if (session.config.mode === 'pair' && session.config.voiceEnabled) {
        await this.speakLine(normalized, lineNum, lineContent, session.config.voiceRate);
      }

      // Set breakpoint and step
      try {
        await this.validateLine(session, store, normalized, lineNum, lineInfo);
        
        // Mark line as cleared
        await store.markLineCleared(normalized, lineNum);
        session.totalLinesValidated++;
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const validationError: ValidationError = {
          file: normalized,
          line: lineNum,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
          occurredAt: new Date()
        };
        
        session.errorsFound.push(validationError);
        await store.recordError(normalized, lineNum, errorMessage, validationError.stack);
        
        // In pair mode, speak the error
        if (session.config.mode === 'pair' && session.config.voiceEnabled) {
          await this.speakError(normalized, lineNum, errorMessage);
        }
        
        // Continue or stop based on configuration
        if (session.config.mode === 'pair') {
          // In pair mode, pause for user intervention
          session.state = 'paused';
          throw new Error(`Error at ${normalized}:${lineNum}: ${errorMessage}`);
        }
      }
    }
  }

  /**
   * Validate a single line
   */
  private async validateLine(
    session: ValidationSession,
    store: ClearedLinesStore,
    filePath: string,
    lineNum: number,
    lineInfo: LineInfo
  ): Promise<void> {
    const debugSession = this.sessionManager.getSession(session.debugSessionId);
    if (!debugSession) {
      throw new Error(`Debug session ${session.debugSessionId} not found`);
    }
    
    // Set breakpoint on this line
    const breakpoint = await this.sessionManager.setBreakpoint(
      session.debugSessionId, 
      filePath, 
      lineNum
    );

    // If not already paused, continue to hit the breakpoint
    if (debugSession.executionState !== ExecutionState.PAUSED) {
      await this.sessionManager.continue(session.debugSessionId);
      
      // Wait for stopped event
      await this.waitForStopped(session.debugSessionId, 5000);
    }

    // Now step over this line
    await this.sessionManager.stepOver(session.debugSessionId);
    
    // Wait for the step to complete
    await this.waitForStopped(session.debugSessionId, 5000);

    // If this line has function calls and followCalls is enabled, analyze the stack
    if (session.config.followCalls && lineInfo.functionCalls && lineInfo.functionCalls.length > 0) {
      await this.handleFunctionCalls(session, store, lineInfo);
    }

    // Remove the breakpoint by setting a new breakpoint list without this one
    // (since there's no removeBreakpoint method, we'll just leave it for now)
  }

  /**
   * Handle function calls by stepping into them
   */
  private async handleFunctionCalls(
    session: ValidationSession,
    store: ClearedLinesStore,
    _lineInfo: LineInfo
  ): Promise<void> {
    // Get current stack trace
    const stackFrames = await this.sessionManager.getStackTrace(session.debugSessionId);
    
    if (stackFrames.length > 1) {
      // We're inside a function call
      const calledFrame = stackFrames[0];
      
      if (calledFrame.file && calledFrame.line) {
        this.logger.info(`[ValidationManager] Stepping into function at ${calledFrame.file}:${calledFrame.line}`);
        
        // Recursively validate the called function
        await this.validateFile(session, store, calledFrame.file, calledFrame.line);
        
        // Step out to return to caller
        await this.sessionManager.stepOut(session.debugSessionId);
        await this.waitForStopped(session.debugSessionId, 5000);
      }
    }
  }

  /**
   * Analyze a line to determine its type and extract information
   */
  private analyzeLineWaiting(filePath: string, lineNum: number, content: string): LineInfo {
    const trimmed = content.trim();
    const info: LineInfo = {
      file: filePath,
      line: lineNum,
      content,
      type: 'other'
    };

    // Detect imports
    if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
      info.type = 'import';
      info.importedModules = this.extractImports(trimmed);
    }
    // Detect function definitions
    else if (trimmed.startsWith('def ')) {
      info.type = 'function_def';
    }
    // Detect method definitions (indented def)
    else if (/^\s+def /.test(content)) {
      info.type = 'method_def';
    }
    // Detect return statements
    else if (trimmed.startsWith('return')) {
      info.type = 'return';
    }
    // Detect control flow
    else if (/^(if|elif|else|for|while|try|except|finally|with)/.test(trimmed)) {
      info.type = 'control';
    }
    // Detect assignments
    else if (trimmed.includes('=') && !trimmed.includes('==')) {
      info.type = 'assignment';
    }
    // Detect function calls (simple heuristic)
    else if (/\w+\s*\(/.test(trimmed)) {
      info.type = 'function_call';
      info.functionCalls = this.extractFunctionCalls(trimmed);
    }

    return info;
  }

  /**
   * Extract function names from a line with function calls
   */
  private extractFunctionCalls(line: string): string[] {
    const calls: string[] = [];
    const regex = /(\w+)\s*\(/g;
    let match;
    
    while ((match = regex.exec(line)) !== null) {
      calls.push(match[1]);
    }
    
    return calls;
  }

  /**
   * Extract module names from import statements
   */
  private extractImports(line: string): string[] {
    const modules: string[] = [];
    
    if (line.startsWith('import ')) {
      const parts = line.substring(7).split(',');
      modules.push(...parts.map(p => p.trim().split(' ')[0]));
    } else if (line.startsWith('from ')) {
      const match = /from\s+(\S+)\s+import/.exec(line);
      if (match) {
        modules.push(match[1]);
      }
    }
    
    return modules;
  }

  /**
   * Check if a line is executable
   */
  private isExecutableLine(lineInfo: LineInfo): boolean {
    const nonExecutableTypes = ['import', 'function_def', 'method_def'];
    if (nonExecutableTypes.includes(lineInfo.type)) {
      return false;
    }
    
    const trimmed = lineInfo.content.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === 'pass') {
      return false;
    }
    
    return true;
  }

  /**
   * Wait for debugger to stop
   */
  private async waitForStopped(sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for debugger to stop`));
      }, timeoutMs);

      const session = this.sessionManager.getSession(sessionId);
      if (!session || !session.proxyManager) {
        clearTimeout(timeout);
        reject(new Error('No proxy manager or session not found'));
        return;
      }

      session.proxyManager.once('stopped', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * Speak a line using macOS say
   */
  private async speakLine(file: string, line: number, content: string, rate?: number): Promise<void> {
    const basename = path.basename(file);
    const text = `Line ${line} in ${basename}: ${content.trim()}`;
    const rateArg = rate ? `-r ${rate}` : '';
    
    try {
      execSync(`say ${rateArg} "${text.replace(/"/g, '\\"')}"`);
    } catch (error) {
      this.logger.error('[ValidationManager] Failed to speak line:', error);
    }
  }

  /**
   * Speak an error using macOS say
   */
  private async speakError(file: string, line: number, error: string): Promise<void> {
    const basename = path.basename(file);
    const text = `Error at line ${line} in ${basename}: ${error}`;
    
    try {
      execSync(`say "${text.replace(/"/g, '\\"')}"`);
    } catch (error) {
      this.logger.error('[ValidationManager] Failed to speak error:', error);
    }
  }

  /**
   * Pause validation
   */
  async pauseValidation(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = 'paused';
      this.logger.info(`[ValidationManager] Paused validation session ${sessionId}`);
    }
  }

  /**
   * Get validation statistics
   */
  async getStatistics(sessionId: string): Promise<any> {
    const store = this.clearedStores.get(sessionId);
    if (!store) {
      throw new Error(`No store found for session ${sessionId}`);
    }
    
    return await store.getStatistics();
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): ValidationSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all validation sessions
   */
  listSessions(): ValidationSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Close a validation session
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      const store = this.clearedStores.get(sessionId);
      if (store) {
        await store.persist();
        this.clearedStores.delete(sessionId);
      }
      
      this.sessions.delete(sessionId);
      this.logger.info(`[ValidationManager] Closed validation session ${sessionId}`);
    }
  }
}