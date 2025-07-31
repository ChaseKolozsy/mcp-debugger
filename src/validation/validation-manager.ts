/**
 * ValidationManager - Manages line-by-line code validation sessions
 */
import { EventEmitter } from 'events';
import * as path from 'path';
import { spawn } from 'child_process';
import { 
  ValidationSession,
  ValidationConfig,
  ValidationResult,
  ValidationError,
  LineInfo
} from './models.js';
import { ClearedLinesStore } from './cleared-lines-store.js';
import { SessionManager } from '../session/session-manager.js';
import { ExecutionState } from '../session/models.js';
import { v4 as uuidv4 } from 'uuid';

export class ValidationManager extends EventEmitter {
  private sessions = new Map<string, ValidationSession>();
  private clearedStores = new Map<string, ClearedLinesStore>();

  constructor(
    private sessionManager: SessionManager,
    private logger: any,
    private fileSystem: any
  ) {
    super();
  }

  /**
   * Create a new validation session
   */
  async createValidationSession(config: ValidationConfig): Promise<string> {
    const sessionId = uuidv4();
    
    const session: ValidationSession = {
      id: sessionId,
      config,
      state: 'running',
      debugSessionId: config.sessionId,
      totalLinesValidated: 0,
      errorsFound: [],
      currentFile: config.startFile,
      currentLine: config.startLine || 1,
      filesProcessed: new Set(),
      startedAt: new Date()
    };

    this.sessions.set(sessionId, session);

    // Create cleared lines store
    const store = new ClearedLinesStore(
      config.persistencePath || './validation-data', 
      { logger: this.logger }
    );
    await store.initialize();
    this.clearedStores.set(sessionId, store);

    this.logger.info(`[ValidationManager] Created validation session ${sessionId}`);
    return sessionId;
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

    // Check debug session exists
    const debugSession = this.sessionManager.getSession(session.debugSessionId);
    if (!debugSession) {
      throw new Error(`Debug session ${session.debugSessionId} not found`);
    }

    session.state = 'running';
    session.startedAt = new Date();

    try {
      // Check if debugging is already started
      const executionState = debugSession.executionState;
      
      this.logger.info(`[ValidationManager] Debug session state: ${debugSession.state}, execution: ${executionState}`);
      
      // If not paused, we need to wait for it
      if (executionState !== ExecutionState.PAUSED) {
        this.logger.info('[ValidationManager] Waiting for debug session to pause...');
        await this.waitForStopped(session.debugSessionId, 10000);
      }

      // Start validation from current position
      await this.validateExecution(session, store);

      session.state = 'completed';

      return {
        success: true,
        session,
        message: 'Validation completed successfully'
      };
    } catch (error) {
      session.state = 'error';
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[ValidationManager] Validation error: ${errorMessage}`, error);

      return {
        success: false,
        session,
        errors: session.errorsFound,
        message: `Validation failed: ${errorMessage}`
      };
    }
  }

  /**
   * Main validation loop - follows execution flow
   */
  private async validateExecution(
    session: ValidationSession,
    store: ClearedLinesStore
  ): Promise<void> {
    const processedLines = new Set<string>(); // Track file:line combinations

    while (session.state === 'running') {
      try {
        // Get current execution position
        const stackTrace = await this.sessionManager.getStackTrace(session.debugSessionId);
        if (!stackTrace || stackTrace.length === 0) {
          this.logger.warn('[ValidationManager] No stack trace available, ending validation');
          break;
        }

        const currentFrame = stackTrace[0];
        if (!currentFrame || !currentFrame.file || !currentFrame.line) {
          this.logger.warn('[ValidationManager] Invalid stack frame, ending validation');
          break;
        }

        const currentFile = path.resolve(currentFrame.file);
        const currentLine = currentFrame.line;
        const lineKey = `${currentFile}:${currentLine}`;

        // Update session position
        session.currentFile = currentFile;
        session.currentLine = currentLine;

        // Check if we've already processed this exact line in this session
        if (processedLines.has(lineKey)) {
          this.logger.debug(`[ValidationManager] Already processed ${lineKey} in this session, stepping over`);
          await this.stepAndWait(session);
          continue;
        }

        processedLines.add(lineKey);

        // Check if line is already cleared from previous runs
        if (session.config.skipCleared && await store.isLineCleared(currentFile, currentLine)) {
          this.logger.debug(`[ValidationManager] Line ${lineKey} already cleared, stepping over`);
          await this.stepAndWait(session);
          continue;
        }

        // Read the line content
        let lineContent = '';
        try {
          const fileContent = await this.fileSystem.readFile(currentFile, 'utf-8');
          const lines = fileContent.split('\n');
          lineContent = lines[currentLine - 1] || '';
        } catch (error) {
          this.logger.warn(`[ValidationManager] Could not read file ${currentFile}: ${error}`);
        }

        // Analyze the line
        const lineInfo = this.analyzeLine(currentFile, currentLine, lineContent);

        // In pair mode, speak the line
        if (session.config.mode === 'pair' && session.config.voiceEnabled) {
          await this.speakLine(lineInfo, session.config.voiceRate);
        }

        // Check if we should step into or over
        let shouldStepInto = false;
        if (session.config.followCalls && this.looksLikeFunctionCall(lineContent)) {
          shouldStepInto = true;
        }

        // Perform the step
        if (shouldStepInto) {
          await this.stepIntoAndWait(session);
        } else {
          await this.stepAndWait(session);
        }

        // Mark line as cleared
        await store.markLineCleared(currentFile, currentLine);
        session.totalLinesValidated++;

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Check if it's a normal termination
        if (errorMessage.includes('exited') || errorMessage.includes('terminated')) {
          this.logger.info('[ValidationManager] Program terminated normally');
          break;
        }

        // Record the error
        const validationError: ValidationError = {
          file: session.currentFile || '',
          line: session.currentLine || 0,
          error: errorMessage,
          occurredAt: new Date()
        };
        
        session.errorsFound.push(validationError);
        this.logger.error(`[ValidationManager] Error at ${session.currentFile}:${session.currentLine}: ${errorMessage}`);

        // In pair mode, speak the error
        if (session.config.mode === 'pair' && session.config.voiceEnabled) {
          await this.speakError(errorMessage, session.config.voiceRate);
        }

        // Try to continue
        try {
          await this.stepAndWait(session);
        } catch (stepError) {
          this.logger.error('[ValidationManager] Cannot continue after error, ending validation');
          break;
        }
      }
    }
  }

  /**
   * Step over and wait for stopped event
   */
  private async stepAndWait(session: ValidationSession): Promise<void> {
    const result = await this.sessionManager.stepOver(session.debugSessionId);
    if (!result.success) {
      throw new Error(`Step failed: ${result.error}`);
    }
    await this.waitForStopped(session.debugSessionId, 5000);
  }

  /**
   * Step into and wait for stopped event
   */
  private async stepIntoAndWait(session: ValidationSession): Promise<void> {
    const result = await this.sessionManager.stepInto(session.debugSessionId);
    if (!result.success) {
      throw new Error(`Step into failed: ${result.error}`);
    }
    await this.waitForStopped(session.debugSessionId, 5000);
  }

  /**
   * Wait for debugger to stop
   */
  private async waitForStopped(sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for debugger to stop`));
      }, timeoutMs);

      // Check if already paused
      const session = this.sessionManager.getSession(sessionId);
      if (session?.executionState === ExecutionState.PAUSED) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      // Wait for stopped event
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
   * Analyze a line to determine its type
   */
  private analyzeLine(filePath: string, lineNum: number, content: string): LineInfo {
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
    // Detect class definitions (mapped to function_def for now)
    else if (trimmed.startsWith('class ')) {
      info.type = 'function_def';
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
    // Detect function calls
    else if (/\w+\s*\(/.test(trimmed)) {
      info.type = 'function_call';
      info.functionCalls = this.extractFunctionCalls(trimmed);
    }

    return info;
  }

  /**
   * Check if a line looks like it contains a function call
   */
  private looksLikeFunctionCall(line: string): boolean {
    const trimmed = line.trim();
    // Simple heuristic - contains parentheses and not a definition
    return /\w+\s*\(/.test(trimmed) && 
           !trimmed.startsWith('def ') && 
           !trimmed.startsWith('class ') &&
           !trimmed.startsWith('if ') &&
           !trimmed.startsWith('while ') &&
           !trimmed.startsWith('for ');
  }

  /**
   * Extract function names from a line
   */
  private extractFunctionCalls(line: string): string[] {
    const calls: string[] = [];
    const regex = /(\w+)\s*\(/g;
    let match;
    
    while ((match = regex.exec(line)) !== null) {
      // Skip Python keywords
      const keywords = ['if', 'while', 'for', 'def', 'class', 'with', 'except'];
      if (!keywords.includes(match[1])) {
        calls.push(match[1]);
      }
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
   * Speak a line using macOS say
   */
  private async speakLine(lineInfo: LineInfo, rate?: number): Promise<void> {
    const text = `Line ${lineInfo.line}: ${lineInfo.content.trim()}`;
    await this.speak(text, rate);
  }

  /**
   * Speak an error
   */
  private async speakError(error: string, rate?: number): Promise<void> {
    const text = `Error: ${error}`;
    await this.speak(text, rate);
  }

  /**
   * Speak text using macOS say command
   */
  private async speak(text: string, rate: number = 200): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('say', ['-r', String(rate), text]);
      
      proc.on('error', (err) => {
        this.logger.error('[ValidationManager] Failed to speak:', err);
        reject(err);
      });
      
      proc.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`say command exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Pause validation
   */
  pauseValidation(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.state === 'running') {
      session.state = 'paused';
      this.logger.info(`[ValidationManager] Paused validation session ${sessionId}`);
    }
  }

  /**
   * Get validation statistics
   */
  async getStatistics(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    const store = this.clearedStores.get(sessionId);
    
    if (!session || !store) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const stats = await store.getStatistics();
    
    return {
      session: {
        id: session.id,
        state: session.state,
        totalLinesValidated: session.totalLinesValidated,
        errorsFound: session.errorsFound.length,
        currentFile: session.currentFile,
        currentLine: session.currentLine,
        startedAt: session.startedAt
      },
      store: stats
    };
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
  async closeValidationSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = 'completed';
    }

    const store = this.clearedStores.get(sessionId);
    if (store) {
      // Store doesn't have a close method, just remove it
      this.clearedStores.delete(sessionId);
    }

    this.sessions.delete(sessionId);
    this.logger.info(`[ValidationManager] Closed validation session ${sessionId}`);
  }

  // Aliases for backward compatibility
  createSession = this.createValidationSession;
  closeSession = this.closeValidationSession;
}