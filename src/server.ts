
/**
 * Debug MCP Server - Main Server Implementation
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
// StdioServerTransport is used in index.ts, not here
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode as McpErrorCode, 
  McpError,
  ServerResult, 
} from '@modelcontextprotocol/sdk/types.js';
import { SessionManager, SessionManagerConfig } from './session/session-manager.js';
import { createProductionDependencies } from './container/dependencies.js';
import { ContainerConfig } from './container/types.js';
import { 
    DebugSessionInfo, 
    Variable, 
    StackFrame, 
    DebugLanguage,
    Breakpoint,
    SessionLifecycleState 
} from './session/models.js';
import { DebugProtocol } from '@vscode/debugprotocol';
import path from 'path';
import { VoiceOutput, VoiceOutputConfig } from './utils/voice-output.js';
import { VoiceFormatter } from './utils/voice-formatter.js';
/**
 * Configuration options for the Debug MCP Server
 */
export interface DebugMcpServerOptions {
  logLevel?: string;
  logFile?: string;
}

/**
 * Language metadata for supported languages
 */
interface LanguageMetadata {
  id: string;
  displayName: string;
  version: string;
  requiresExecutable: boolean;
  defaultExecutable?: string;
}

/**
 * Tool arguments interface
 */
interface ToolArguments {
  sessionId?: string;
  language?: string;
  name?: string;
  executablePath?: string;  // Language-agnostic executable path
  enableVoiceOutput?: boolean;
  voiceConfig?: {
    voice?: string;
    rate?: number;
  };
  file?: string;
  line?: number;
  condition?: string;
  scriptPath?: string;
  args?: string[];
  dapLaunchArgs?: Partial<DebugProtocol.LaunchRequestArguments>;
  dryRunSpawn?: boolean;
  scope?: number;
  frameId?: number;
  expression?: string;
  linesContext?: number;
}

/**
 * Main Debug MCP Server class
 */
export class DebugMcpServer {
  public server: Server;
  private sessionManager: SessionManager;
  private logger;
  private constructorOptions: DebugMcpServerOptions;
  private supportedLanguages: string[] = [];
  private voiceOutputs: Map<string, VoiceOutput> = new Map();

  // Get supported languages from adapter registry
  private getSupportedLanguages(): string[] {
    const adapterRegistry = this.getAdapterRegistry();
    return adapterRegistry.getSupportedLanguages();
  }

  // Get language metadata for all supported languages
  private getLanguageMetadata(): LanguageMetadata[] {
    const adapterRegistry = this.getAdapterRegistry();
    const languages = adapterRegistry.getSupportedLanguages();
    
    // Map to metadata - in future, this info will come from adapter registry
    return languages.map((lang: string) => {
      switch (lang) {
        case 'python':
          return {
            id: 'python',
            displayName: 'Python',
            version: '1.0.0',
            requiresExecutable: true,
            defaultExecutable: 'python'
          };
        case 'mock':
          return {
            id: 'mock',
            displayName: 'Mock',
            version: '1.0.0',
            requiresExecutable: false
          };
        default:
          return {
            id: lang,
            displayName: lang.charAt(0).toUpperCase() + lang.slice(1),
            version: '1.0.0',
            requiresExecutable: true
          };
      }
    });
  }

  /**
   * Validate session exists and is not terminated
   */
  private validateSession(sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new McpError(McpErrorCode.InvalidParams, `Session not found: ${sessionId}`);
    }
    // Check the new lifecycle state instead of legacy state
    if (session.sessionLifecycle === SessionLifecycleState.TERMINATED) {
      throw new McpError(McpErrorCode.InvalidRequest, `Session is terminated: ${sessionId}`);
    }
  }

  // Public methods to expose SessionManager functionality for testing/external use
  public async createDebugSession(params: { language: DebugLanguage; name?: string; executablePath?: string; enableVoiceOutput?: boolean; voiceConfig?: { voice?: string; rate?: number; } }): Promise<DebugSessionInfo> {
    // Validate language support
    const adapterRegistry = this.getAdapterRegistry();
    if (!adapterRegistry.isLanguageSupported(params.language)) {
      const supported = adapterRegistry.getSupportedLanguages();
      throw new McpError(
        McpErrorCode.InvalidParams, 
        `Language '${params.language}' is not supported. Available languages: ${supported.join(', ')}`
      );
    }
    
    const name = params.name || `${params.language}-debug-${Date.now()}`;
    try {
      const sessionInfo: DebugSessionInfo = await this.sessionManager.createSession({
        language: params.language as DebugLanguage,
        name: name,
        executablePath: params.executablePath,  // Use executablePath for consistency
        enableVoiceOutput: params.enableVoiceOutput,
        voiceConfig: params.voiceConfig
      });
      
      // Create VoiceOutput instance if voice is enabled
      if (params.enableVoiceOutput) {
        const voiceConfig: VoiceOutputConfig = {
          enabled: true,
          voice: params.voiceConfig?.voice,
          rate: params.voiceConfig?.rate
        };
        const voiceOutput = new VoiceOutput(voiceConfig, this.logger);
        this.voiceOutputs.set(sessionInfo.id, voiceOutput);
      }
      return sessionInfo;
    } catch (error) {
      const errorMessage = (error as Error).message || String(error);
      this.logger.error('Failed to create debug session', { error: errorMessage, stack: (error as Error).stack });
      throw new McpError(McpErrorCode.InternalError, `Failed to create debug session: ${errorMessage}`);
    }
  }

  public async startDebugging(
    sessionId: string, 
    scriptPath: string, 
    args?: string[], 
    dapLaunchArgs?: Partial<DebugProtocol.LaunchRequestArguments>, 
    dryRunSpawn?: boolean
  ): Promise<{ success: boolean; state: string; error?: string; data?: unknown; }> {
    this.validateSession(sessionId);
    
    // In container mode, prepend /workspace/ to the path
    if (process.env.MCP_CONTAINER === 'true') {
      scriptPath = `/workspace/${scriptPath}`;
    }
    
    this.logger.info(`[DebugMcpServer.startDebugging] Using scriptPath: ${scriptPath}`);
    const result = await this.sessionManager.startDebugging(
      sessionId, 
      scriptPath, 
      args, 
      dapLaunchArgs, 
      dryRunSpawn
    );
    return result;
  }

  public async closeDebugSession(sessionId: string): Promise<boolean> {
    // Clean up voice output for this session
    this.voiceOutputs.delete(sessionId);
    return this.sessionManager.closeSession(sessionId);
  }

  public async setBreakpoint(sessionId: string, file: string, line: number, condition?: string): Promise<Breakpoint> {
    this.validateSession(sessionId);
    
    // In container mode, prepend /workspace/ to the path
    if (process.env.MCP_CONTAINER === 'true') {
      file = `/workspace/${file}`;
    }
    
    this.logger.info(`[DebugMcpServer.setBreakpoint] Using file path: ${file}`);
    return this.sessionManager.setBreakpoint(sessionId, file, line, condition);
  }

  public async setBreakpoints(sessionId: string, file: string): Promise<{ success: boolean; breakpoints: Breakpoint[]; errors: string[] }> {
    this.validateSession(sessionId);
    
    // In container mode, prepend /workspace/ to the path
    if (process.env.MCP_CONTAINER === 'true') {
      file = `/workspace/${file}`;
    }
    
    this.logger.info(`[DebugMcpServer.setBreakpoints] Using file path: ${file}`);
    return this.sessionManager.setBreakpoints(sessionId, file);
  }

  public async getVariables(sessionId: string, variablesReference: number): Promise<Variable[]> {
    this.validateSession(sessionId);
    return this.sessionManager.getVariables(sessionId, variablesReference);
  }

  public async getStackTrace(sessionId: string): Promise<StackFrame[]> {
    this.validateSession(sessionId);
    const session = this.sessionManager.getSession(sessionId);
    const currentThreadId = session?.proxyManager?.getCurrentThreadId();
    if (!session || !session.proxyManager || !currentThreadId) {
        throw new McpError(McpErrorCode.InvalidRequest, "Cannot get stack trace: no active proxy, thread, or session not found/paused.");
    }
    return this.sessionManager.getStackTrace(sessionId, currentThreadId);
  }

  public async getScopes(sessionId: string, frameId: number): Promise<DebugProtocol.Scope[]> {
    this.validateSession(sessionId);
    return this.sessionManager.getScopes(sessionId, frameId);
  }

  public async continueExecution(sessionId: string): Promise<boolean> {
    this.validateSession(sessionId);
    const result = await this.sessionManager.continue(sessionId);
    if (!result.success) {
      throw new Error(result.error || 'Failed to continue execution');
    }
    return true;
  }

  public async stepOver(sessionId: string): Promise<boolean> {
    this.validateSession(sessionId);
    const result = await this.sessionManager.stepOver(sessionId);
    if (!result.success) {
      throw new Error(result.error || 'Failed to step over');
    }
    return true;
  }

  public async stepInto(sessionId: string): Promise<boolean> {
    this.validateSession(sessionId);
    const result = await this.sessionManager.stepInto(sessionId);
    if (!result.success) {
      throw new Error(result.error || 'Failed to step into');
    }
    return true;
  }

  public async stepOut(sessionId: string): Promise<boolean> {
    this.validateSession(sessionId);
    const result = await this.sessionManager.stepOut(sessionId);
    if (!result.success) {
      throw new Error(result.error || 'Failed to step out');
    }
    return true;
  }

  constructor(options: DebugMcpServerOptions = {}) {
    this.constructorOptions = options;
    
    const containerConfig: ContainerConfig = {
      logLevel: options.logLevel,
      logFile: options.logFile,
      sessionLogDirBase: options.logFile ? path.resolve(path.dirname(options.logFile), 'sessions') : undefined
    };
    
    const dependencies = createProductionDependencies(containerConfig);
    
    this.logger = dependencies.logger;
    this.logger.info('[DebugMcpServer Constructor] Main server logger instance assigned.');

    this.server = new Server(
      { name: 'debug-mcp-server', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );

    const sessionManagerConfig: SessionManagerConfig = {
      logDirBase: containerConfig.sessionLogDirBase
    };
    
    this.sessionManager = new SessionManager(sessionManagerConfig, dependencies);

    this.registerTools();
    this.server.onerror = (error) => {
      this.logger.error('Server error', { error });
    };
  }

  /**
   * Sanitize request data for logging (remove sensitive information)
   */
  private sanitizeRequest(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...args };
    // Remove absolute paths from executablePath
    if (sanitized.executablePath && typeof sanitized.executablePath === 'string' && path.isAbsolute(sanitized.executablePath)) {
      sanitized.executablePath = '<absolute-path>';
    }
    // Truncate long arrays
    if (sanitized.args && Array.isArray(sanitized.args) && sanitized.args.length > 5) {
      sanitized.args = [...sanitized.args.slice(0, 5), `... +${sanitized.args.length - 5} more`];
    }
    return sanitized;
  }

  /**
   * Get session name for logging
   */
  private getSessionName(sessionId: string): string {
    try {
      const session = this.sessionManager.getSession(sessionId);
      return session?.name || 'Unknown Session';
    } catch {
      return 'Unknown Session';
    }
  }

  private getPathDescription(parameterName: string): string {
    // Hands-off approach: provide simple, generic path guidance
    // Let OS/containers/debug adapters handle paths naturally
    if (parameterName === 'script') {
      return `Path to the script to debug. Use absolute paths or paths relative to your current working directory`;
    }
    return `Path to the ${parameterName}. Use absolute paths or paths relative to your current working directory`;
  }

  private registerTools(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.debug('Handling ListToolsRequest');
      
      // Get supported languages dynamically - deferred until request time
      let supportedLanguages: string[];
      try {
        supportedLanguages = this.getSupportedLanguages();
      } catch (error) {
        // Fallback if adapter registry isn't ready
        supportedLanguages = ['python', 'mock'];
        this.logger.warn('Adapter registry not ready, using default languages', { error });
      }
      
      // Generate dynamic descriptions for path parameters
      const fileDescription = this.getPathDescription('source file');
      const scriptPathDescription = this.getPathDescription('script');
      
      return {
        tools: [
          { name: 'create_debug_session', description: 'Create a new debugging session', inputSchema: { type: 'object', properties: { language: { type: 'string', enum: supportedLanguages, description: 'Programming language for debugging' }, name: { type: 'string', description: 'Optional session name' }, executablePath: {type: 'string', description: 'Path to language executable (optional, will auto-detect if not provided)'}, enableVoiceOutput: { type: 'boolean', description: 'Enable macOS voice output for all responses' }, voiceConfig: { type: 'object', properties: { voice: { type: 'string', description: 'macOS voice name (e.g., Alex, Samantha)' }, rate: { type: 'number', description: 'Speech rate in words per minute' } } } }, required: ['language'] } },
          { name: 'list_supported_languages', description: 'List all supported debugging languages with metadata', inputSchema: { type: 'object', properties: {} } },
          { name: 'list_debug_sessions', description: 'List all active debugging sessions', inputSchema: { type: 'object', properties: {} } },
          { name: 'set_breakpoint', description: 'Set a breakpoint. Setting breakpoints on non-executable lines (structural, declarative) may lead to unexpected behavior', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, file: { type: 'string', description: fileDescription }, line: { type: 'number', description: 'Line number where to set breakpoint. Executable statements (assignments, function calls, conditionals, returns) work best. Structural lines (function/class definitions), declarative lines (imports), or non-executable lines (comments, blank lines) may cause unexpected stepping behavior' }, condition: { type: 'string' } }, required: ['sessionId', 'file', 'line'] } },
          { name: 'set_breakpoints', description: 'Set breakpoints on all executable lines in a file', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, file: { type: 'string', description: fileDescription } }, required: ['sessionId', 'file'] } },
          { name: 'start_debugging', description: 'Start debugging a script', inputSchema: { 
              type: 'object', 
              properties: { 
                sessionId: { type: 'string' }, 
                scriptPath: { type: 'string', description: scriptPathDescription }, 
                args: { type: 'array', items: { type: 'string' } }, 
                dapLaunchArgs: { 
                  type: 'object', 
                  properties: { 
                    stopOnEntry: { type: 'boolean' },
                    justMyCode: { type: 'boolean' } 
                  },
                  additionalProperties: true
                },
                dryRunSpawn: { type: 'boolean' } 
              }, 
              required: ['sessionId', 'scriptPath'] 
            } 
          },
          { name: 'close_debug_session', description: 'Close a debugging session', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
          { name: 'step_over', description: 'Step over', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
          { name: 'step_into', description: 'Step into', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
          { name: 'step_out', description: 'Step out', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
          { name: 'continue_execution', description: 'Continue execution', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
          { name: 'pause_execution', description: 'Pause execution (Not Implemented)', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
          { name: 'get_variables', description: 'Get variables (scope is variablesReference: number)', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, scope: { type: 'number', description: "The variablesReference number from a StackFrame or Variable" } }, required: ['sessionId', 'scope'] } },
          { name: 'get_stack_trace', description: 'Get stack trace', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
          { name: 'get_scopes', description: 'Get scopes for a stack frame', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, frameId: { type: 'number', description: "The ID of the stack frame from a stackTrace response" } }, required: ['sessionId', 'frameId'] } },
          { name: 'evaluate_expression', description: 'Evaluate expression (Not Implemented)', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, expression: { type: 'string' } }, required: ['sessionId', 'expression'] } },
          { name: 'get_source_context', description: 'Get source context (Not Implemented)', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, file: { type: 'string', description: fileDescription }, line: { type: 'number' }, linesContext: { type: 'number' } }, required: ['sessionId', 'file', 'line'] } },
        ],
      };
    });

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<ServerResult> => {
        const toolName = request.params.name;
        const args = request.params.arguments as ToolArguments; 

        // Log tool call with structured logging
        this.logger.info('tool:call', {
          tool: toolName,
          sessionId: args.sessionId,
          sessionName: args.sessionId ? this.getSessionName(args.sessionId) : undefined,
          request: this.sanitizeRequest(args as Record<string, unknown>),
          timestamp: Date.now()
        });

        try {
          let result: ServerResult;
          
          switch (toolName) {
            case 'create_debug_session': {
              const sessionInfo = await this.createDebugSession({
                language: (args.language || 'python') as DebugLanguage,
                name: args.name,
                executablePath: args.executablePath,
                enableVoiceOutput: args.enableVoiceOutput,
                voiceConfig: args.voiceConfig
              });
              
              // Log session creation
              this.logger.info('session:created', {
                sessionId: sessionInfo.id,
                sessionName: sessionInfo.name,
                language: sessionInfo.language,
                executablePath: args.executablePath,
                timestamp: Date.now()
              });
              
              result = { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: sessionInfo.id, message: `Created ${sessionInfo.language} debug session: ${sessionInfo.name}` }) }] };
              break;
            }
            case 'list_debug_sessions': {
              result = await this.handleListDebugSessions();
              break;
            }
            case 'set_breakpoint': {
              if (!args.sessionId || !args.file || args.line === undefined) {
                throw new McpError(McpErrorCode.InvalidParams, 'Missing required parameters');
              }
              
              try {
                const breakpoint = await this.setBreakpoint(args.sessionId, args.file, args.line, args.condition);
                
                // Log breakpoint event
                this.logger.info('debug:breakpoint', {
                  event: 'set',
                  sessionId: args.sessionId,
                  sessionName: this.getSessionName(args.sessionId),
                  breakpointId: breakpoint.id,
                  file: breakpoint.file,
                  line: breakpoint.line,
                  verified: breakpoint.verified,
                  timestamp: Date.now()
                });
                
                const fileName = breakpoint.file.split('/').pop() || 'file';
                result = { content: [{ type: 'text', text: JSON.stringify({ success: true, breakpointId: breakpoint.id, file: breakpoint.file, line: breakpoint.line, verified: breakpoint.verified, message: `Breakpoint set at ${fileName}:${breakpoint.line}` }) }] };
              } catch (error) {
                // Handle validation errors specifically
                if (error instanceof McpError && 
                    (error.message.includes('terminated') || 
                     error.message.includes('closed') || 
                     error.message.includes('not found'))) {
                  result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }] };
                } else {
                  // Re-throw unexpected errors
                  throw error;
                }
              }
              break;
            }
            case 'set_breakpoints': {
              if (!args.sessionId || !args.file) {
                throw new McpError(McpErrorCode.InvalidParams, 'Missing required parameters');
              }
              
              try {
                const breakpointsResult = await this.setBreakpoints(args.sessionId, args.file);
                
                // Log breakpoints event
                this.logger.info('debug:breakpoints', {
                  event: 'bulk_set',
                  sessionId: args.sessionId,
                  sessionName: this.getSessionName(args.sessionId),
                  file: args.file,
                  breakpointCount: breakpointsResult.breakpoints.length,
                  errorCount: breakpointsResult.errors.length,
                  timestamp: Date.now()
                });
                
                result = { content: [{ type: 'text', text: JSON.stringify({ 
                  success: breakpointsResult.success, 
                  breakpointCount: breakpointsResult.breakpoints.length,
                  breakpoints: breakpointsResult.breakpoints.map(bp => ({ 
                    id: bp.id, 
                    file: bp.file, 
                    line: bp.line, 
                    verified: bp.verified 
                  })),
                  errors: breakpointsResult.errors,
                  message: `Set ${breakpointsResult.breakpoints.length} breakpoints${breakpointsResult.errors.length > 0 ? ` with ${breakpointsResult.errors.length} errors` : ''}`
                }) }] };
              } catch (error) {
                // Handle validation errors specifically
                if (error instanceof McpError && 
                    (error.message.includes('terminated') || 
                     error.message.includes('closed') || 
                     error.message.includes('not found'))) {
                  result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }] };
                } else {
                  // Re-throw unexpected errors
                  throw error;
                }
              }
              break;
            }
            case 'start_debugging': {
              if (!args.sessionId || !args.scriptPath) {
                throw new McpError(McpErrorCode.InvalidParams, 'Missing required parameters');
              }
              
              try {
                const debugResult = await this.startDebugging(args.sessionId, args.scriptPath, args.args, args.dapLaunchArgs, args.dryRunSpawn);
                const responsePayload: Record<string, unknown> = {
                  success: debugResult.success,
                  state: debugResult.state,
                  message: debugResult.error ? debugResult.error : (debugResult.data as Record<string, unknown>)?.message || `Operation status for ${args.scriptPath}`,
                };
                if (debugResult.data) {
                  responsePayload.data = debugResult.data;
                }
                result = { content: [{ type: 'text', text: JSON.stringify(responsePayload) }] };
              } catch (error) {
                // Handle validation errors specifically
                if (error instanceof McpError && 
                    (error.message.includes('terminated') || 
                     error.message.includes('closed') || 
                     error.message.includes('not found'))) {
                  result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message, state: 'stopped' }) }] };
                } else {
                  // Re-throw unexpected errors
                  throw error;
                }
              }
              break;
            }
            case 'close_debug_session': {
              if (!args.sessionId) {
                throw new McpError(McpErrorCode.InvalidParams, 'Missing required sessionId');
              }
              
              const sessionName = this.getSessionName(args.sessionId);
              const sessionCreatedAt = Date.now(); // In real implementation, would track creation time
              const closed = await this.closeDebugSession(args.sessionId);
              
              if (closed) {
                // Log session closure
                this.logger.info('session:closed', {
                  sessionId: args.sessionId,
                  sessionName: sessionName,
                  duration: Date.now() - sessionCreatedAt,
                  timestamp: Date.now()
                });
              }
              
              result = { content: [{ type: 'text', text: JSON.stringify({ success: closed, message: closed ? `Closed debug session: ${args.sessionId}` : `Failed to close debug session: ${args.sessionId}` }) }] };
              break;
            }
            case 'step_over':
            case 'step_into':
            case 'step_out': {
              if (!args.sessionId) {
                throw new McpError(McpErrorCode.InvalidParams, 'Missing required sessionId');
              }
              
              try {
                let stepResult: boolean;
                if (toolName === 'step_over') {
                  stepResult = await this.stepOver(args.sessionId);
                } else if (toolName === 'step_into') {
                  stepResult = await this.stepInto(args.sessionId);
                } else {
                  stepResult = await this.stepOut(args.sessionId);
                }
                result = { content: [{ type: 'text', text: JSON.stringify({ success: stepResult, message: stepResult ? `Stepped ${toolName.replace('step_', '')}` : `Failed to ${toolName.replace('_', ' ')}` }) }] };
              } catch (error) {
                // Handle validation errors specifically
                if (error instanceof McpError && 
                    (error.message.includes('terminated') || 
                     error.message.includes('closed') || 
                     error.message.includes('not found'))) {
                  result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }] };
                } else if (error instanceof Error) {
                  // Handle other expected errors (like "Failed to step over")
                  result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }] };
                } else {
                  // Re-throw unexpected errors
                  throw error;
                }
              }
              break;
            }
            case 'continue_execution': {
              if (!args.sessionId) {
                throw new McpError(McpErrorCode.InvalidParams, 'Missing required sessionId');
              }
              
              try {
                const continueResult = await this.continueExecution(args.sessionId);
                result = { content: [{ type: 'text', text: JSON.stringify({ success: continueResult, message: continueResult ? 'Continued execution' : 'Failed to continue execution' }) }] };
              } catch (error) {
                // Handle validation errors specifically
                if (error instanceof McpError && 
                    (error.message.includes('terminated') || 
                     error.message.includes('closed') || 
                     error.message.includes('not found'))) {
                  result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }] };
                } else if (error instanceof Error) {
                  // Handle other expected errors
                  result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }] };
                } else {
                  // Re-throw unexpected errors
                  throw error;
                }
              }
              break;
            }
            case 'pause_execution': {
              result = await this.handlePause(args as { sessionId: string });
              break;
            }
            case 'get_variables': {
              if (!args.sessionId || args.scope === undefined) {
                throw new McpError(McpErrorCode.InvalidParams, 'Missing required parameters');
              }
              
              try {
                const variables = await this.getVariables(args.sessionId, args.scope);
                
                // Log variable inspection (truncate large values)
                const truncatedVars = variables.map(v => ({
                  name: v.name,
                  type: v.type,
                  value: v.value.length > 200 ? v.value.substring(0, 200) + '... (truncated)' : v.value
                }));
                
                this.logger.info('debug:variables', {
                  sessionId: args.sessionId,
                  sessionName: this.getSessionName(args.sessionId),
                  variablesReference: args.scope,
                  variableCount: variables.length,
                  variables: truncatedVars.slice(0, 10), // Log first 10 variables
                  timestamp: Date.now()
                });
                
                result = { content: [{ type: 'text', text: JSON.stringify({ success: true, variables, count: variables.length, variablesReference: args.scope }) }] };
              } catch (error) {
                // Handle validation errors specifically
                if (error instanceof McpError && 
                    (error.message.includes('terminated') || 
                     error.message.includes('closed') || 
                     error.message.includes('not found'))) {
                  result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }] };
                } else {
                  // Re-throw unexpected errors
                  throw error;
                }
              }
              break;
            }
            case 'get_stack_trace': {
              if (!args.sessionId) {
                throw new McpError(McpErrorCode.InvalidParams, 'Missing required sessionId');
              }
              
              try {
                const stackFrames = await this.getStackTrace(args.sessionId);
                result = { content: [{ type: 'text', text: JSON.stringify({ success: true, stackFrames, count: stackFrames.length }) }] };
              } catch (error) {
                // Handle validation errors specifically
                if (error instanceof McpError && 
                    (error.message.includes('terminated') || 
                     error.message.includes('closed') || 
                     error.message.includes('not found') ||
                     error.message.includes('Cannot get stack trace'))) {
                  result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }] };
                } else {
                  // Re-throw unexpected errors
                  throw error;
                }
              }
              break;
            }
            case 'get_scopes': {
              if (!args.sessionId || args.frameId === undefined) {
                throw new McpError(McpErrorCode.InvalidParams, 'Missing required parameters');
              }
              
              try {
                const scopes = await this.getScopes(args.sessionId, args.frameId);
                result = { content: [{ type: 'text', text: JSON.stringify({ success: true, scopes }) }] };
              } catch (error) {
                // Handle validation errors specifically
                if (error instanceof McpError && 
                    (error.message.includes('terminated') || 
                     error.message.includes('closed') || 
                     error.message.includes('not found'))) {
                  result = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }] };
                } else {
                  // Re-throw unexpected errors
                  throw error;
                }
              }
              break;
            }
            case 'evaluate_expression': {
              result = await this.handleEvaluateExpression(args as { sessionId: string; expression: string });
              break;
            }
            case 'get_source_context': {
              result = await this.handleGetSourceContext(args as { sessionId: string; file: string; line: number; linesContext?: number });
              break;
            }
            case 'list_supported_languages': {
              result = await this.handleListSupportedLanguages();
              break;
            }
            default:
              throw new McpError(McpErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
          }
          
          // Log successful tool response
          this.logger.info('tool:response', {
            tool: toolName,
            sessionId: args.sessionId,
            sessionName: args.sessionId ? this.getSessionName(args.sessionId) : undefined,
            success: true,
            timestamp: Date.now()
          });
          
          // Speak the result if voice output is enabled for the session
          if (args.sessionId && 'content' in result && result.content && Array.isArray(result.content) && result.content.length > 0) {
            const voiceOutput = this.voiceOutputs.get(args.sessionId);
            if (voiceOutput && voiceOutput.isEnabled()) {
              const textContent = result.content.find((c: any) => c.type === 'text');
              if (textContent && 'text' in textContent) {
                // Parse JSON to extract a readable message
                try {
                  const jsonData = JSON.parse(textContent.text);
                  let spokenText = '';
                  
                  // Extract meaningful text from different response types
                  if (jsonData.message) {
                    spokenText = jsonData.message;
                  } else if (jsonData.error) {
                    spokenText = `Error: ${jsonData.error}`;
                  } else if (jsonData.variables && Array.isArray(jsonData.variables)) {
                    // Use VoiceFormatter for intelligent variable formatting
                    spokenText = VoiceFormatter.formatVariables(jsonData.variables);
                  } else if (jsonData.stackFrames && Array.isArray(jsonData.stackFrames)) {
                    // Use VoiceFormatter for stack frame information
                    const frameCount = jsonData.stackFrames.length;
                    if (frameCount === 0) {
                      spokenText = 'No stack frames';
                    } else {
                      spokenText = `Paused at ${VoiceFormatter.formatStackFrame(jsonData.stackFrames[0])}`;
                      if (frameCount > 1) {
                        spokenText += `, with ${frameCount - 1} more frames in the call stack`;
                      }
                    }
                  } else if (jsonData.scopes && Array.isArray(jsonData.scopes)) {
                    // Use VoiceFormatter for scope information
                    spokenText = VoiceFormatter.formatScopes(jsonData.scopes);
                  } else if (jsonData.breakpoints && Array.isArray(jsonData.breakpoints)) {
                    // Speak breakpoint information
                    const bpCount = jsonData.breakpoints.length;
                    if (bpCount === 0) {
                      spokenText = 'No breakpoints set';
                    } else if (bpCount === 1) {
                      const bp = jsonData.breakpoints[0];
                      spokenText = `Set breakpoint at line ${bp.line}`;
                    } else {
                      spokenText = `Set ${bpCount} breakpoints`;
                    }
                  } else if (jsonData.state) {
                    // Speak state changes
                    spokenText = `Debugger state: ${jsonData.state}`;
                    if (jsonData.data && jsonData.data.reason) {
                      spokenText += ` due to ${jsonData.data.reason}`;
                    }
                  } else if (jsonData.breakpointCount !== undefined) {
                    // Speak bulk breakpoint results
                    if (jsonData.errors && jsonData.errors.length > 0) {
                      spokenText = `Set ${jsonData.breakpointCount} breakpoints with ${jsonData.errors.length} errors`;
                    } else {
                      spokenText = `Successfully set ${jsonData.breakpointCount} breakpoints`;
                    }
                  } else if (jsonData.breakpointCount !== undefined) {
                    spokenText = `Set ${jsonData.breakpointCount} breakpoints`;
                  } else if (jsonData.sessions) {
                    spokenText = `Found ${jsonData.count || jsonData.sessions.length} debug sessions`;
                  } else if (toolName === 'continue_execution' && jsonData.success) {
                    spokenText = 'Continuing execution';
                  } else if (toolName.startsWith('step_') && jsonData.success) {
                    spokenText = `${toolName.replace('_', ' ')} completed`;
                  }
                  
                  if (spokenText) {
                    // Use async speak to not block the response
                    voiceOutput.speakAsync(spokenText);
                  }
                } catch (parseError) {
                  // If not JSON, speak the raw text
                  voiceOutput.speakAsync(textContent.text);
                }
              }
            }
          }
          
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          
          // Log tool error
          this.logger.error('tool:error', {
            tool: toolName,
            sessionId: args.sessionId,
            sessionName: args.sessionId ? this.getSessionName(args.sessionId) : undefined,
            error: errorMessage,
            timestamp: Date.now()
          });
          
          if (error instanceof McpError) throw error;
          throw new McpError(McpErrorCode.InternalError, `Failed to execute tool ${toolName}: ${errorMessage}`);
        }
      }
    );
  }

  private async handleListDebugSessions(): Promise<ServerResult> {
    try {
      const sessionsInfo: DebugSessionInfo[] = this.sessionManager.getAllSessions();
      const sessionData = sessionsInfo.map((session: DebugSessionInfo) => {
        const mappedSession: Record<string, unknown> = { 
            id: session.id, 
            name: session.name, 
            language: session.language as DebugLanguage, 
            state: session.state, 
            createdAt: session.createdAt.toISOString(),
        };
        if (session.updatedAt) { 
            mappedSession.updatedAt = session.updatedAt.toISOString();
        }
        return mappedSession;
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, sessions: sessionData, count: sessionData.length }) }] };
    } catch (error) {
      this.logger.error('Failed to list debug sessions', { error });
      throw new McpError(McpErrorCode.InternalError, `Failed to list debug sessions: ${(error as Error).message}`);
    }
  }

  private async handlePause(args: { sessionId: string }): Promise<ServerResult> {
    try {
      this.logger.info(`Pause requested for session: ${args.sessionId}`);
      throw new McpError(McpErrorCode.InternalError, "Pause execution not yet implemented with proxy.");
    } catch (error) {
      this.logger.error('Failed to pause execution', { error });
      if (error instanceof McpError) throw error;
      throw new McpError(McpErrorCode.InternalError, `Failed to pause execution: ${(error as Error).message}`);
    }
  }

  private async handleEvaluateExpression(args: { sessionId: string, expression: string }): Promise<ServerResult> {
    try {
      this.logger.info(`Evaluate requested for session: ${args.sessionId}, expression: ${args.expression}`);
      throw new McpError(McpErrorCode.InternalError, "Evaluate expression not yet implemented with proxy.");
    } catch (error) {
      this.logger.error('Failed to evaluate expression', { error });
      if (error instanceof McpError) throw error;
      throw new McpError(McpErrorCode.InternalError, `Failed to evaluate expression: ${(error as Error).message}`);
    }
  }

  private async handleGetSourceContext(args: { sessionId: string, file: string, line: number, linesContext?: number }): Promise<ServerResult> {
    try {
      // In container mode, prepend /workspace/ to the path
      let file = args.file;
      if (process.env.MCP_CONTAINER === 'true') {
        file = `/workspace/${file}`;
      }
      
      this.logger.info(`Source context requested for session: ${args.sessionId}, file: ${file}, line: ${args.line}`);
      throw new McpError(McpErrorCode.InternalError, "Get source context not yet implemented with proxy.");
    } catch (error) {
      this.logger.error('Failed to get source context', { error });
      if (error instanceof McpError) throw error;
      throw new McpError(McpErrorCode.InternalError, `Failed to get source context: ${(error as Error).message}`);
    }
  }

  private async handleListSupportedLanguages(): Promise<ServerResult> {
    try {
      const languages = this.getLanguageMetadata();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, languages, count: languages.length }) }] };
    } catch (error) {
      this.logger.error('Failed to list supported languages', { error });
      throw new McpError(McpErrorCode.InternalError, `Failed to list supported languages: ${(error as Error).message}`);
    }
  }

  /**
   * Public methods for server lifecycle management
   */
  public async start(): Promise<void> {
    // For MCP servers, start is handled by transport
    this.logger.info('Debug MCP Server started');
  }

  public async stop(): Promise<void> {
    await this.sessionManager.closeAllSessions();
    this.logger.info('Debug MCP Server stopped');
  }

  /**
   * Get adapter registry from session manager
   */
  public getAdapterRegistry() {
    return this.sessionManager.adapterRegistry;
  }
}
