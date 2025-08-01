/**
 * Python line analyzer for identifying executable lines in Python files
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface LineInfo {
  lineNumber: number;
  content: string;
  isExecutable: boolean;
  reason?: string;
}

export class PythonLineAnalyzer {
  /**
   * Analyze a Python file and return information about each line
   */
  async analyzeFile(filePath: string): Promise<LineInfo[]> {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    const fileContent = await fs.readFile(absolutePath, 'utf-8');
    const lines = fileContent.split('\n');
    
    return lines.map((line, index) => {
      const lineNumber = index + 1;
      return {
        lineNumber,
        content: line,
        isExecutable: this.isExecutableLine(line, lineNumber, lines),
        reason: this.getLineType(line)
      };
    });
  }

  /**
   * Get executable lines from a Python file
   */
  async getExecutableLines(filePath: string): Promise<number[]> {
    const lineInfos = await this.analyzeFile(filePath);
    return lineInfos
      .filter(info => info.isExecutable)
      .map(info => info.lineNumber);
  }

  /**
   * Determine if a line is executable
   */
  private isExecutableLine(line: string, lineNumber: number, allLines: string[]): boolean {
    const trimmed = line.trim();
    
    // Empty lines and comments are not executable
    if (trimmed === '' || trimmed.startsWith('#')) {
      return false;
    }
    
    // Docstrings are not executable
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      return false;
    }
    
    // Check if line is inside a multi-line string
    if (this.isInsideMultiLineString(lineNumber - 1, allLines)) {
      return false;
    }
    
    // Decorators are not directly executable
    if (trimmed.startsWith('@')) {
      return false;
    }
    
    // Class and function definitions are structural, not executable
    if (trimmed.startsWith('class ') || trimmed.startsWith('def ')) {
      return false;
    }
    
    // Import statements are declarative, not ideal for breakpoints
    if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
      return false;
    }
    
    // Continuation lines (ending with backslash) might not be good breakpoint locations
    if (trimmed.endsWith('\\')) {
      return false;
    }
    
    // Lines that are just closing brackets/parentheses
    if (/^[\]\)\}]+[,;]?$/.test(trimmed)) {
      return false;
    }
    
    // Everything else is potentially executable
    return true;
  }

  /**
   * Check if a line is inside a multi-line string
   */
  private isInsideMultiLineString(lineIndex: number, lines: string[]): boolean {
    let inTripleQuote = false;
    let quoteType: string | null = null;
    
    for (let i = 0; i < lineIndex; i++) {
      const line = lines[i];
      
      // Check for triple quotes
      const tripleDoubleMatch = line.match(/"""/g);
      const tripleSingleMatch = line.match(/'''/g);
      
      if (tripleDoubleMatch) {
        const count = tripleDoubleMatch.length;
        if (count % 2 === 1) {
          if (!inTripleQuote) {
            inTripleQuote = true;
            quoteType = '"""';
          } else if (quoteType === '"""') {
            inTripleQuote = false;
            quoteType = null;
          }
        }
      }
      
      if (tripleSingleMatch) {
        const count = tripleSingleMatch.length;
        if (count % 2 === 1) {
          if (!inTripleQuote) {
            inTripleQuote = true;
            quoteType = "'''";
          } else if (quoteType === "'''") {
            inTripleQuote = false;
            quoteType = null;
          }
        }
      }
    }
    
    return inTripleQuote;
  }

  /**
   * Get a descriptive type for the line
   */
  private getLineType(line: string): string {
    const trimmed = line.trim();
    
    if (trimmed === '') return 'empty';
    if (trimmed.startsWith('#')) return 'comment';
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) return 'docstring';
    if (trimmed.startsWith('@')) return 'decorator';
    if (trimmed.startsWith('class ')) return 'class_definition';
    if (trimmed.startsWith('def ')) return 'function_definition';
    if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) return 'import';
    if (/^[\]\)\}]+[,;]?$/.test(trimmed)) return 'closing_bracket';
    
    // Check for common executable patterns
    if (trimmed.includes('=') && !trimmed.startsWith('def')) return 'assignment';
    if (trimmed.startsWith('if ')) return 'conditional';
    if (trimmed.startsWith('elif ') || trimmed.startsWith('else:')) return 'conditional';
    if (trimmed.startsWith('for ') || trimmed.startsWith('while ')) return 'loop';
    if (trimmed.startsWith('try:') || trimmed.startsWith('except') || trimmed.startsWith('finally:')) return 'exception_handling';
    if (trimmed.startsWith('return ')) return 'return_statement';
    if (trimmed.startsWith('yield ')) return 'yield_statement';
    if (trimmed.startsWith('raise ')) return 'raise_statement';
    if (trimmed.startsWith('pass') || trimmed.startsWith('break') || trimmed.startsWith('continue')) return 'control_flow';
    
    // If it contains parentheses, it's likely a function call
    if (trimmed.includes('(') && trimmed.includes(')')) return 'function_call';
    
    return 'other';
  }
}