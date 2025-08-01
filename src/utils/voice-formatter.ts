/**
 * Voice output formatter for debugging information
 * Intelligently formats debug data for text-to-speech output
 */

export interface Variable {
  name: string;
  value: string;
  type: string;
  variablesReference?: number;
  expandable?: boolean;
}

export class VoiceFormatter {
  // Skip these variable categories
  private static readonly SKIP_PATTERNS = [
    /^__.*__$/,           // Dunder methods/attributes
    /^_.*$/,              // Private attributes
    /^special variables$/, // Debug adapter special category
    /^function variables$/,// Debug adapter function category
    /^class variables$/,   // Debug adapter class category
  ];

  // Common built-in types to skip or simplify
  private static readonly BUILTIN_MODULES = new Set([
    'builtins', 'sys', 'os', 'importlib', 'collections',
    'functools', 'itertools', 'operator', 'types'
  ]);

  /**
   * Format variables for voice output with intelligent filtering
   */
  static formatVariables(variables: Variable[], maxVars: number = 5): string {
    // Filter out internal/special variables
    const userVars = variables.filter(v => this.isUserVariable(v));

    if (userVars.length === 0) {
      // Check if we only have special categories
      const hasSpecialCategories = variables.some(v => 
        v.name === 'special variables' || 
        v.name === 'function variables' || 
        v.name === 'class variables'
      );
      
      if (hasSpecialCategories) {
        return 'No user-defined variables yet';
      }
      return 'No variables found';
    }

    // Format based on count
    if (userVars.length === 1) {
      return this.formatSingleVariable(userVars[0]);
    } else if (userVars.length <= maxVars) {
      return this.formatMultipleVariables(userVars);
    } else {
      return this.formatManyVariables(userVars, maxVars);
    }
  }

  /**
   * Check if a variable is user-defined (not internal Python stuff)
   */
  private static isUserVariable(variable: Variable): boolean {
    // Skip variables matching our patterns
    for (const pattern of this.SKIP_PATTERNS) {
      if (pattern.test(variable.name)) {
        return false;
      }
    }

    // Skip module references to built-in modules
    if (variable.type === 'module' && this.BUILTIN_MODULES.has(variable.name)) {
      return false;
    }

    return true;
  }

  /**
   * Format a single variable
   */
  private static formatSingleVariable(variable: Variable): string {
    const value = this.formatValue(variable);
    return `Variable ${variable.name} is ${value}`;
  }

  /**
   * Format multiple variables (2-5)
   */
  private static formatMultipleVariables(variables: Variable[]): string {
    const varDescriptions = variables.map(v => {
      const value = this.formatValue(v);
      return `${v.name} is ${value}`;
    });
    
    return `Found ${variables.length} variables: ${varDescriptions.join(', ')}`;
  }

  /**
   * Format many variables (more than maxVars)
   */
  private static formatManyVariables(variables: Variable[], maxVars: number): string {
    const firstVars = variables.slice(0, maxVars).map(v => v.name).join(', ');
    const remaining = variables.length - maxVars;
    return `Found ${variables.length} variables including ${firstVars} and ${remaining} more`;
  }

  /**
   * Format a variable value intelligently
   */
  private static formatValue(variable: Variable): string {
    // Handle empty values
    if (!variable.value || variable.value === '') {
      if (variable.expandable) {
        return `a ${variable.type} object`;
      }
      return 'empty';
    }

    // Handle different types
    switch (variable.type) {
      case 'str':
        return this.formatString(variable.value);
      case 'int':
      case 'float':
        return variable.value;
      case 'bool':
        return variable.value;
      case 'NoneType':
        return 'None';
      case 'list':
        return this.formatList(variable.value);
      case 'dict':
        return this.formatDict(variable.value);
      case 'function':
        return `a function`;
      case 'method':
        return `a method`;
      case 'type':
        return `a class ${variable.value}`;
      default:
        // For objects, try to extract useful info
        if (variable.expandable) {
          return `a ${variable.type} instance`;
        }
        // Truncate long values
        if (variable.value.length > 50) {
          return variable.value.substring(0, 47) + '...';
        }
        return variable.value;
    }
  }

  /**
   * Format string values
   */
  private static formatString(value: string): string {
    // Remove quotes if present
    const cleaned = value.replace(/^['"]|['"]$/g, '');
    
    // Truncate long strings
    if (cleaned.length > 30) {
      return `"${cleaned.substring(0, 27)}..."`;
    }
    
    return `"${cleaned}"`;
  }

  /**
   * Format list values
   */
  private static formatList(value: string): string {
    // Try to extract length from representation
    const lengthMatch = value.match(/\[.*\]/);
    if (lengthMatch) {
      const items = value.split(',').length;
      if (items > 3) {
        return `a list with ${items} items`;
      }
    }
    
    // Truncate if too long
    if (value.length > 50) {
      return 'a list';
    }
    
    return value;
  }

  /**
   * Format dict values
   */
  private static formatDict(value: string): string {
    // Try to extract number of keys
    const keyMatch = value.match(/\{.*\}/);
    if (keyMatch) {
      const pairs = value.split(',').length;
      if (pairs > 3) {
        return `a dictionary with ${pairs} entries`;
      }
    }
    
    // Truncate if too long
    if (value.length > 50) {
      return 'a dictionary';
    }
    
    return value;
  }

  /**
   * Format stack frame information
   */
  static formatStackFrame(frame: any): string {
    const fileName = frame.file ? frame.file.split('/').pop() : 'unknown file';
    const functionName = frame.name && frame.name !== '<module>' ? 
      ` in function ${frame.name}` : '';
    
    return `Line ${frame.line} of ${fileName}${functionName}`;
  }

  /**
   * Format scope information focusing on what matters
   */
  static formatScopes(scopes: any[]): string {
    // Only mention scopes that typically have user variables
    const relevantScopes = scopes.filter(s => 
      s.name === 'Locals' || s.name === 'Globals'
    );
    
    if (relevantScopes.length === 0) {
      return 'No variable scopes available';
    }
    
    const scopeNames = relevantScopes.map(s => s.name).join(' and ');
    return `${scopeNames} scope${relevantScopes.length > 1 ? 's' : ''} available`;
  }

  /**
   * Format a complete debugging state summary
   */
  static formatDebugState(data: any): string {
    const parts: string[] = [];

    // Current location
    if (data.stackFrames && data.stackFrames.length > 0) {
      parts.push(this.formatStackFrame(data.stackFrames[0]));
    }

    // Variables summary
    if (data.variables) {
      parts.push(this.formatVariables(data.variables));
    }

    // Reason for pause
    if (data.reason) {
      parts.push(`stopped at ${data.reason}`);
    }

    return parts.join('. ');
  }
}