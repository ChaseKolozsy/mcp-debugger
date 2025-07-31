# Line Validation Tool Examples

This directory contains example scripts for testing the MCP debugger's line validation tool.

## Overview

The line validation tool automatically steps through code line by line, validating each executable line and tracking which lines have been successfully cleared. It supports two modes:

1. **Pair Mode**: Interactive mode with voice output (macOS only)
2. **Auto Mode**: Silent automated validation

## Features

- Intelligent stepping that follows function/method calls
- Persistent tracking of cleared lines
- Automatic skipping of non-executable lines (comments, imports, function definitions)
- Error detection and reporting
- Voice output in pair mode using macOS `say` command

## Usage

### 1. Start the MCP debugger server

```bash
npm run build
node dist/index.js
```

### 2. Create a debug session

Using the MCP client, create a Python debug session:

```json
{
  "tool": "create_debug_session",
  "arguments": {
    "language": "python",
    "name": "validation-test"
  }
}
```

### 3. Create a validation session

Create a validation session in either pair or auto mode:

**Pair Mode (with voice):**
```json
{
  "tool": "create_validation_session",
  "arguments": {
    "sessionId": "<debug-session-id>",
    "mode": "pair",
    "startFile": "examples/validation/test_validation.py",
    "followCalls": true,
    "skipCleared": true,
    "voiceEnabled": true,
    "voiceRate": 200
  }
}
```

**Auto Mode (silent):**
```json
{
  "tool": "create_validation_session",  
  "arguments": {
    "sessionId": "<debug-session-id>",
    "mode": "auto",
    "startFile": "examples/validation/test_validation.py",
    "followCalls": true,
    "skipCleared": true
  }
}
```

### 4. Start the validation

```json
{
  "tool": "start_validation",
  "arguments": {
    "validationSessionId": "<validation-session-id>"
  }
}
```

### 5. Monitor progress

Get validation statistics:

```json
{
  "tool": "get_validation_statistics",
  "arguments": {
    "validationSessionId": "<validation-session-id>"
  }
}
```

List all validation sessions:

```json
{
  "tool": "list_validation_sessions",
  "arguments": {}
}
```

## Test Script

The `test_validation.py` script includes:

- Import statements (skipped)
- Function definitions (skipped)
- Function calls (validated)
- Recursive functions (followed)
- Class methods (validated)
- Control flow statements
- Exception handling
- List comprehensions

## Cleared Lines Persistence

The tool stores cleared lines in a JSON file (default: `.mcp-debugger/cleared-lines.json`). This file tracks:

- Which lines have been validated
- File hashes to detect modifications
- Validation errors
- Statistics per file

When a file is modified, its cleared lines are automatically invalidated.

## Error Handling

If an error occurs during validation:

- In **pair mode**: The session pauses and speaks the error
- In **auto mode**: The error is logged and validation continues

All errors are stored in the cleared lines database for review.