import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';

// --- SDK-based MCP Client for Testing ---
let client: Client | null = null;

async function startTestServer(): Promise<void> {
  const currentFileURL = import.meta.url;
  const currentFilePath = fileURLToPath(currentFileURL);
  const currentDirName = path.dirname(currentFilePath);
  const serverScriptPath = path.resolve(currentDirName, '../../dist/index.js');
  console.log(`[Test Setup] Server script path for SDK StdioClientTransport: ${serverScriptPath}`);

  client = new Client({
    name: "real-discovery-test-client",
    version: "0.1.0",
    capabilities: { tools: {} }
  });

  const filteredEnv: Record<string, string> = {};
  for (const key in process.env) {
    // Copy all environment variables except PATH, to ensure Python is not found
    if (process.env[key] !== undefined && key.toUpperCase() !== 'PATH') {
      filteredEnv[key] = process.env[key] as string;
    }
  }
  
  // Detect if running in Act environment
  const isAct = process.env.ACT === 'true';
  
  // Set PATH to only include the Node.js directory
  let nodeDir: string;
  if (isAct || process.platform !== 'win32') {
    // In Act or on Linux/macOS, use which/command to find node
    const nodeExePath = process.execPath; // Use current Node.js executable path
    nodeDir = path.dirname(nodeExePath);
  } else {
    // On Windows (non-Act), use the standard location
    const nodeExePath = 'C:\\Program Files\\nodejs\\node.exe';
    nodeDir = path.dirname(nodeExePath);
  }
  filteredEnv['PATH'] = nodeDir;
  const logFilePath = path.resolve(currentDirName, '../../integration_test_server_real_discovery.log');
  console.log(`[Test Setup] Server log file will be at: ${logFilePath}`);
  try {
    if (fs.existsSync(logFilePath)) {
      fs.unlinkSync(logFilePath);
    }
  } catch (e) { console.error(`Error deleting old log file: ${e}`); }

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverScriptPath, '--log-level', 'debug', '--log-file', logFilePath],
    env: filteredEnv,
  });

  try {
    console.log('[Test Server] Attempting to connect SDK client (which will spawn server)...');
    await client.connect(transport);
    console.log('[Test Server] SDK Client connected, server spawned, and initialized successfully.');
  } catch (error) {
    console.error('[Test Server] SDK Client connection/spawn/initialization failed:', error);
    client = null;
    throw error;
  }
}

async function stopTestServer(): Promise<void> {
  if (client) {
    console.log('[Test Server] Closing SDK client connection (should terminate server)...');
    try {
      await client.close();
      console.log('[Test Server] SDK Client closed successfully.');
    } catch (e) {
      console.error('[Test Server] Error closing SDK client:', e);
    }
  }
  client = null;
}

// Helper to parse ServerResult
const parseToolResult = (rawResult: unknown) => {
  const anyResult = rawResult as { content?: Array<{ type?: string; text?: string }> };
  if (!anyResult || !anyResult.content || !anyResult.content[0] || anyResult.content[0].type !== 'text' || !anyResult.content[0].text) {
    console.error("Invalid ServerResult structure received:", rawResult);
    throw new Error('Invalid ServerResult structure');
  }
  return JSON.parse(anyResult.content[0].text);
};

describe('Real Python discovery on Windows PowerShell', { tag: '@requires-python' }, () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalPythonPath: string | undefined;
  let originalPythonExecutable: string | undefined;

  beforeAll(async () => {
    await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  beforeEach(() => {
    // Store original environment variables
    originalPythonPath = process.env.PYTHON_PATH;
    originalPythonExecutable = process.env.PYTHON_EXECUTABLE;

    // Clear environment variables to force auto-detection
    delete process.env.PYTHON_PATH;
    delete process.env.PYTHON_EXECUTABLE;

    // Stub platform to ensure Windows behavior is tested
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    // Restore original environment variables
    if (originalPythonPath !== undefined) {
      process.env.PYTHON_PATH = originalPythonPath;
    } else {
      delete process.env.PYTHON_PATH;
    }
    if (originalPythonExecutable !== undefined) {
      process.env.PYTHON_EXECUTABLE = originalPythonExecutable;
    } else {
      delete process.env.PYTHON_EXECUTABLE;
    }

    // Restore original platform
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    vi.restoreAllMocks();
  });

  // TODO: Re-enable after fixing Act platform detection issues
  // This test forces platform to 'win32' but runs on Linux in Act, causing 'py' command check to fail
  it.skip('should show clear error message when Python is not found on Windows (verifying production bug fix)', async () => {
    if (!client) {
      throw new Error("MCP Client not initialized. Cannot run test.");
    }

    // This test verifies the fix for the garbled character bug in Python discovery error messages.
    // When Python is not found, the error message should be clear and readable.

    let sessionId: string | undefined;
    let startResult: { success: boolean; message?: string; error?: string };
    try {
      const createRawResult = await client.callTool({ name: 'create_debug_session', arguments: { language: 'python', name: 'RealDiscoveryTest' } });
      const createResult = parseToolResult(createRawResult);
      expect(createResult.success).toBe(true);
      sessionId = createResult.sessionId;

      const scriptPath = path.resolve('examples/python/fibonacci.py');
      const startRawResult = await client.callTool({ name: 'start_debugging', arguments: { sessionId, scriptPath } });
      startResult = parseToolResult(startRawResult);
    } finally {
      if (sessionId) {
        await client.callTool({ name: 'close_debug_session', arguments: { sessionId } });
      }
    }

    expect(startResult.success).toBe(false);
    expect(startResult.message).toMatch(/Python not found/);
    // Verify the error message shows what was tried (order doesn't matter)
    expect(startResult.message).toMatch(/Tried:/);
    expect(startResult.message).toContain('→ not found');
    // On Windows, it should try 'py'
    if (process.platform === 'win32') {
      expect(startResult.message).toContain('py → not found');
    }
    // All platforms should try python and python3
    expect(startResult.message).toContain('python → not found');
    expect(startResult.message).toContain('python3 → not found');
    // Ensure no garbled characters are present
    expect(startResult.message).not.toMatch(/ΓåÆ|ΓÇª/);
  }, 30000); // Increased timeout for real system calls and server startup
});
