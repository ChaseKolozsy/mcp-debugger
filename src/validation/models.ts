/**
 * Models for the line validation system
 */

/**
 * Represents a cleared line in a file
 */
export interface ClearedLine {
  file: string;
  line: number;
  clearedAt: Date;
  fileHash?: string; // Hash of file content to detect changes
}

/**
 * Represents the validation state of a file
 */
export interface FileValidationState {
  filePath: string;
  lastModified: Date;
  fileHash: string;
  clearedLines: Set<number>;
  totalLines: number;
  errors: ValidationError[];
}

/**
 * Represents an error that occurred during validation
 */
export interface ValidationError {
  file: string;
  line: number;
  error: string;
  stack?: string;
  occurredAt: Date;
}

/**
 * Validation session configuration
 */
export interface ValidationConfig {
  sessionId: string;
  mode: 'pair' | 'auto';
  startFile: string;
  startLine?: number;
  followImports: boolean;
  followCalls: boolean;
  skipCleared: boolean;
  voiceEnabled?: boolean;
  voiceRate?: number;
  persistencePath?: string;
}

/**
 * Validation session state
 */
export interface ValidationSession {
  id: string;
  config: ValidationConfig;
  debugSessionId: string;
  startedAt: Date;
  currentFile?: string;
  currentLine?: number;
  filesProcessed: Set<string>;
  totalLinesValidated: number;
  errorsFound: ValidationError[];
  state: 'running' | 'paused' | 'completed' | 'error';
}

/**
 * Result of a validation operation
 */
export interface ValidationResult {
  success: boolean;
  session: ValidationSession;
  clearedLines?: ClearedLine[];
  errors?: ValidationError[];
  message?: string;
}

/**
 * Line information from source analysis
 */
export interface LineInfo {
  file: string;
  line: number;
  content: string;
  type: 'import' | 'function_def' | 'method_def' | 'function_call' | 'assignment' | 'control' | 'return' | 'other';
  functionCalls?: string[]; // Function names called on this line
  importedModules?: string[]; // Modules imported on this line
}