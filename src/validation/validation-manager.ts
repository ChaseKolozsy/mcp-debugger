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
import { DebugProtocol } from '@vscode/debugprotocol';

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
   * Main validation loop - uses scatter-shot breakpoint approach
   */
  private async validateExecution(
    session: ValidationSession,
    store: ClearedLinesStore
  ): Promise<void> {
    const sessionStartTime = new Date();
    const linesProcessedThisSession = new Set<string>();
    
    try {
      // Get the file we're validating
      const currentFile = path.resolve(session.config.startFile);
      
      // Read the file to get total lines
      const fileContent = await this.fileSystem.readFile(currentFile, 'utf-8');
      const lines = fileContent.split('\n');
      const totalLines = lines.length;
      
      this.logger.info(`[ValidationManager] Analyzing ${totalLines} lines in ${currentFile} for executable breakpoints`);
      
      // Set breakpoints only on executable lines (smart scatter-shot approach)
      const breakpointLines: number[] = [];
      for (let lineNum = 1; lineNum <= totalLines; lineNum++) {
        const lineContent = lines[lineNum - 1] || '';
        const trimmed = lineContent.trim();
        
        // Skip empty lines
        if (trimmed.length === 0) {
          continue;
        }
        
        // Skip comment lines
        if (trimmed.startsWith('#')) {
          continue;
        }
        
        // Skip docstring lines (simple detection)
        if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
          continue;
        }
        
        // Skip lines that were cleared in previous sessions
        if (session.config.skipCleared && await store.isLineCleared(currentFile, lineNum)) {
          const fileState = await store.getFileState(currentFile);
          if (fileState && fileState.lastModified < sessionStartTime) {
            this.logger.debug(`[ValidationManager] Skipping breakpoint at line ${lineNum} - already cleared`);
            continue;
          }
        }
        
        breakpointLines.push(lineNum);
      }
      
      // Remove duplicates and sort
      const uniqueBreakpointLines = [...new Set(breakpointLines)].sort((a, b) => a - b);
      
      this.logger.info(`[ValidationManager] Requesting ${uniqueBreakpointLines.length} breakpoints on executable lines`);
      
      // Set all breakpoints at once
      const bpResponse = await this.setBreakpointsForFile(session.debugSessionId, currentFile, uniqueBreakpointLines);
      const verifiedBreakpoints = bpResponse.filter(bp => bp.verified);
      
      this.logger.info(`[ValidationManager] Set ${verifiedBreakpoints.length} verified breakpoints out of ${uniqueBreakpointLines.length} requested`);
      
      // Check if we're already stopped at a breakpoint
      const initialStackTrace = await this.sessionManager.getStackTrace(session.debugSessionId);
      const alreadyStopped = initialStackTrace && initialStackTrace.length > 0;
      
      // Only continue if we're not already stopped
      if (verifiedBreakpoints.length > 0 && !alreadyStopped) {
        await this.sessionManager.continue(session.debugSessionId);
      }
      
      // Track processed breakpoints to avoid re-processing and to know when we're done
      const processedBreakpoints = new Set<number>();
      
      // Process breakpoints as we hit them
      while (session.state === 'running' && processedBreakpoints.size < verifiedBreakpoints.length) {
        try {
          // Wait for stopped event
          await this.waitForStopped(session.debugSessionId, 15000);
          
          // Get current position
          const stackTrace = await this.sessionManager.getStackTrace(session.debugSessionId);
          if (!stackTrace || stackTrace.length === 0) {
            this.logger.info('[ValidationManager] Program terminated');
            break;
          }
          
          const currentFrame = stackTrace[0];
          if (!currentFrame || !currentFrame.line) {
            continue;
          }
          
          const currentLine = currentFrame.line;
          const lineKey = `${currentFile}:${currentLine}`;
          
          // Update session position
          session.currentFile = currentFile;
          session.currentLine = currentLine;
          
          // Skip if we've already processed this line
          if (processedBreakpoints.has(currentLine)) {
            this.logger.debug(`[ValidationManager] Already processed line ${currentLine}, continuing without speaking`);
            await this.sessionManager.continue(session.debugSessionId);
            continue;
          }
          
          // Process the line (this will speak it)
          await this.processLine(session, store, currentFile, currentLine, lines[currentLine - 1] || '', 
                                sessionStartTime, linesProcessedThisSession);
          
          // Track that we've processed this breakpoint
          processedBreakpoints.add(currentLine);
          
          // Continue to next breakpoint
          await this.sessionManager.continue(session.debugSessionId);
          
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          
          if (errorMessage.includes('exited') || errorMessage.includes('terminated')) {
            this.logger.info('[ValidationManager] Program terminated normally');
            break;
          }
          
          this.logger.error(`[ValidationManager] Error during validation: ${errorMessage}`);
          // Record error and try to continue
          session.errorsFound.push({
            file: session.currentFile || '',
            line: session.currentLine || 0,
            error: errorMessage,
            occurredAt: new Date()
          });
          
          if (session.config.mode === 'pair' && session.config.voiceEnabled) {
            await this.speakError(errorMessage, session.config.voiceRate);
          }
          
          // Try to continue to next breakpoint if we haven't processed all of them
          if (processedBreakpoints.size < verifiedBreakpoints.length) {
            try {
              await this.sessionManager.continue(session.debugSessionId);
            } catch (continueError) {
              this.logger.error('[ValidationManager] Cannot continue after error, ending validation');
              break;
            }
          }
        }
      }
      
    } catch (error) {
      throw error;
    } finally {
      // Clear all breakpoints
      await this.setBreakpointsForFile(session.debugSessionId, session.config.startFile, []);
    }
  }

  /**
   * Process a single line during validation
   */
  private async processLine(
    session: ValidationSession,
    store: ClearedLinesStore,
    currentFile: string,
    currentLine: number,
    lineContent: string,
    sessionStartTime: Date,
    linesProcessedThisSession: Set<string>
  ): Promise<void> {
    const lineKey = `${currentFile}:${currentLine}`;
    linesProcessedThisSession.add(lineKey);
    
    // Check if line was cleared in a previous session
    let shouldSkipReading = false;
    if (session.config.skipCleared && await store.isLineCleared(currentFile, currentLine)) {
      const fileState = await store.getFileState(currentFile);
      if (fileState && fileState.lastModified < sessionStartTime) {
        shouldSkipReading = true;
        this.logger.debug(`[ValidationManager] Line ${lineKey} was cleared in previous session`);
      }
    }
    
    if (!shouldSkipReading) {
      // Analyze and speak the line
      const lineInfo = this.analyzeLine(currentFile, currentLine, lineContent);
      
      if (session.config.mode === 'pair' && session.config.voiceEnabled) {
        await this.speakLine(lineInfo, session.config.voiceRate);
      }
    }
    
    // Mark line as cleared
    await store.markLineCleared(currentFile, currentLine);
    session.totalLinesValidated++;
  }

  /**
   * Set breakpoints for a file using the debug session's proxy manager
   */
  private async setBreakpointsForFile(
    sessionId: string,
    filePath: string,
    lines: number[]
  ): Promise<DebugProtocol.Breakpoint[]> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session?.proxyManager) {
      throw new Error('No proxy manager available');
    }
    
    const response = await session.proxyManager.sendDapRequest<DebugProtocol.SetBreakpointsResponse>(
      'setBreakpoints',
      {
        source: { path: filePath },
        breakpoints: lines.map(line => ({ line }))
      }
    );
    
    return response.body?.breakpoints || [];
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