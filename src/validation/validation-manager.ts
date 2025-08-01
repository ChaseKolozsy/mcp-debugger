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
      
      // Ensure justMyCode is disabled for comprehensive debugging
      this.logger.info('[ValidationManager] Ensuring justMyCode is disabled for comprehensive validation');
      
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
      
      // Process breakpoints as we hit them - let the program run to completion naturally
      let iterationCount = 0;
      const maxIterations = 1000; // Safety limit to prevent infinite loops
      
      this.logger.info(`[ValidationManager] Starting validation loop. Initial session state: ${session.state}`);
      
      while (session.state === 'running') {
        iterationCount++;
        this.logger.debug(`[ValidationManager] Validation loop iteration ${iterationCount}/${maxIterations}`);
        
        if (iterationCount > maxIterations) {
          this.logger.error(`[ValidationManager] Reached maximum iteration limit (${maxIterations}), ending validation to prevent infinite loop`);
          break;
        }
        
        try {
          // Wait for stopped event
          this.logger.debug('[ValidationManager] Waiting for stopped event...');
          await this.waitForStopped(session.debugSessionId, 15000);
          this.logger.debug('[ValidationManager] Stopped event received');
          
          // Get current position
          const stackTrace = await this.sessionManager.getStackTrace(session.debugSessionId);
          if (!stackTrace || stackTrace.length === 0) {
            this.logger.info('[ValidationManager] VALIDATION EXIT: Program terminated - no stack trace available');
            this.logger.info(`[ValidationManager] Final stats: ${iterationCount} iterations, ${linesProcessedThisSession.size} lines processed`);
            break;
          }
          
          const currentFrame = stackTrace[0];
          if (!currentFrame || !currentFrame.line) {
            this.logger.debug('[ValidationManager] No current frame or line info, continuing to next breakpoint');
            await this.sessionManager.continue(session.debugSessionId);
            continue;
          }
          
          const currentLine = currentFrame.line;
          const lineKey = `${currentFile}:${currentLine}`;
          
          this.logger.debug(`[ValidationManager] Processing breakpoint at line ${currentLine}: ${lines[currentLine - 1]?.trim() || 'N/A'}`);
          
          // Update session position
          session.currentFile = currentFile;
          session.currentLine = currentLine;
          
          // Process the line (this will speak it and track it)
          await this.processLine(session, store, currentFile, currentLine, lines[currentLine - 1] || '', 
                                sessionStartTime, linesProcessedThisSession);
          
          // Continue to next breakpoint
          this.logger.debug('[ValidationManager] Continuing to next breakpoint...');
          await this.sessionManager.continue(session.debugSessionId);
          
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          
          if (errorMessage.includes('exited') || errorMessage.includes('terminated')) {
            this.logger.info(`[ValidationManager] VALIDATION EXIT: Program terminated normally after ${iterationCount} iterations`);
            this.logger.info(`[ValidationManager] Final stats: ${linesProcessedThisSession.size} lines processed`);
            break;
          }
          
          if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
            this.logger.error(`[ValidationManager] VALIDATION EXIT: Timeout occurred after ${iterationCount} iterations`);
            this.logger.error(`[ValidationManager] Timeout details: ${errorMessage}`);
            this.logger.info(`[ValidationManager] Lines processed before timeout: ${linesProcessedThisSession.size}`);
            break;
          }
          
          this.logger.error(`[ValidationManager] Error during validation at iteration ${iterationCount}: ${errorMessage}`);
          this.logger.error(`[ValidationManager] Current position: line ${session.currentLine || 'unknown'}`);
          
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
          
          // Try to continue after error
          try {
            this.logger.debug('[ValidationManager] Attempting to continue after error...');
            await this.sessionManager.continue(session.debugSessionId);
          } catch (continueError) {
            const continueErrorMsg = continueError instanceof Error ? continueError.message : String(continueError);
            this.logger.error(`[ValidationManager] VALIDATION EXIT: Cannot continue after error - ${continueErrorMsg}`);
            this.logger.error(`[ValidationManager] Final position: line ${session.currentLine || 'unknown'}, iteration ${iterationCount}`);
            break;
          }
        }
      }
      
      // Check why we exited the loop
      if (session.state !== 'running') {
        this.logger.info(`[ValidationManager] VALIDATION EXIT: Session state changed from 'running' to '${session.state}' after ${iterationCount} iterations`);
        this.logger.info(`[ValidationManager] Final stats: ${linesProcessedThisSession.size} lines processed`);
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
    
    // Always analyze and speak the line during execution stepping
    // The skipCleared logic should only be used during initial breakpoint setting
    const lineInfo = this.analyzeLine(currentFile, currentLine, lineContent);
    
    if (session.config.mode === 'pair' && session.config.voiceEnabled) {
      // If this is a function call, try to evaluate arguments
      let enhancedContent = lineContent;
      if (lineInfo.type === 'function_call') {
        enhancedContent = await this.enhanceFunctionCallWithValues(session.debugSessionId, lineContent);
      }
      
      const enhancedLineInfo = { ...lineInfo, content: enhancedContent };
      await this.speakLine(enhancedLineInfo, session.config.voiceRate);
    }
    
    // Always mark line as cleared when encountered during execution
    await store.markLineCleared(currentFile, currentLine);
    session.totalLinesValidated++;
  }

  /**
   * Enhance function call lines by evaluating argument values
   */
  private async enhanceFunctionCallWithValues(sessionId: string, lineContent: string): Promise<string> {
    try {
      // Match function calls with arguments like self.add_data(data)
      const functionCallRegex = /(\w+(?:\.\w+)*)\s*\(([^)]*)\)/g;
      let enhancedContent = lineContent;
      let match;
      
      while ((match = functionCallRegex.exec(lineContent)) !== null) {
        const functionName = match[1];
        const argsString = match[2].trim();
        
        if (argsString && !argsString.includes('"') && !argsString.includes("'") && !argsString.match(/^\d+$/)) {
          // This looks like a variable argument, try to evaluate it
          try {
            // Get current stack frame variables
            const scopes = await this.getVariablesInCurrentScope(sessionId);
            const argValue = await this.evaluateArgument(argsString, scopes);
            
            if (argValue !== null) {
              // Replace the argument with its evaluated value
              const originalCall = match[0];
              const enhancedCall = `${functionName}(${JSON.stringify(argValue)})`;
              enhancedContent = enhancedContent.replace(originalCall, enhancedCall);
            }
          } catch (error) {
            // If evaluation fails, keep original
            this.logger.debug(`[ValidationManager] Failed to evaluate argument ${argsString}: ${error}`);
          }
        }
      }
      
      return enhancedContent;
    } catch (error) {
      this.logger.debug(`[ValidationManager] Error enhancing function call: ${error}`);
      return lineContent;
    }
  }

  /**
   * Get variables in the current scope
   */
  private async getVariablesInCurrentScope(sessionId: string): Promise<Record<string, any>> {
    try {
      const stackTrace = await this.sessionManager.getStackTrace(sessionId);
      if (!stackTrace || stackTrace.length === 0) {
        return {};
      }
      
      const currentFrame = stackTrace[0];
      const scopes = await this.sessionManager.getScopes(sessionId, currentFrame.id);
      
      const variables: Record<string, any> = {};
      for (const scope of scopes) {
        if (scope.name === 'Locals' || scope.name === 'Arguments') {
          const scopeVars = await this.sessionManager.getVariables(sessionId, scope.variablesReference);
          for (const variable of scopeVars) {
            variables[variable.name] = this.parseVariableValue(variable.value);
          }
        }
      }
      
      return variables;
    } catch (error) {
      this.logger.debug(`[ValidationManager] Error getting variables: ${error}`);
      return {};
    }
  }

  /**
   * Evaluate an argument string using current scope variables
   */
  private async evaluateArgument(argString: string, variables: Record<string, any>): Promise<any> {
    const trimmed = argString.trim();
    
    // Simple variable lookup
    if (variables.hasOwnProperty(trimmed)) {
      return variables[trimmed];
    }
    
    return null;
  }

  /**
   * Parse variable value from debugger string representation
   */
  private parseVariableValue(valueString: string): any {
    if (valueString === 'None') return null;
    if (valueString === 'True') return true;
    if (valueString === 'False') return false;
    
    // Try to parse as number
    const numValue = Number(valueString);
    if (!isNaN(numValue)) return numValue;
    
    // Return as string if it looks like a string
    if (valueString.startsWith("'") && valueString.endsWith("'")) {
      return valueString.slice(1, -1);
    }
    if (valueString.startsWith('"') && valueString.endsWith('"')) {
      return valueString.slice(1, -1);
    }
    
    return valueString;
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