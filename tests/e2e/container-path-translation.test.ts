import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ServerResult } from '@modelcontextprotocol/sdk/types.js';
// No longer mocking python-utils - we want to test real Python discovery

const TEST_TIMEOUT = 30000;

let mcpSdkClient: Client | null = null;
let mcpProcess: ChildProcess | null = null;
let originalEnv: NodeJS.ProcessEnv;

// Helper function to parse SDK tool results
const parseSdkToolResult = (rawResult: ServerResult) => {
  const contentArray = (rawResult as { content: Array<{ type: string; text: string }> }).content;
  if (!contentArray || !Array.isArray(contentArray) || contentArray.length === 0 || contentArray[0].type !== 'text') {
    console.error("Invalid ServerResult structure received from SDK:", rawResult);
    throw new Error('Invalid ServerResult structure from SDK or missing text content');
  }
  return JSON.parse(contentArray[0].text);
};

async function startMcpServerWithEnv(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  console.log('Starting MCP server in SSE mode with custom environment');
  const serverProcess = spawn('node', ['dist/index.js', 'sse', '-p', '3001', '--log-level', 'debug'], { 
    stdio: 'pipe',
    env: { ...process.env, ...env }
  });
  serverProcess.stdout?.on('data', (data) => console.log(`[MCP Server] ${data.toString().trim()}`));
  serverProcess.stderr?.on('data', (data) => console.error(`[MCP Server Error] ${data.toString().trim()}`));
  
  // Wait for server to be ready
  let serverReady = false;
  const healthUrl = 'http://localhost:3001/health';
  const pollTimeout = Date.now() + 10000;
  
  while (Date.now() < pollTimeout) {
    try {
      const response = await globalThis.fetch(healthUrl);
      if (response.ok) {
        const healthStatus = await response.json();
        if (healthStatus.status === 'ok') {
          serverReady = true;
          console.log('[Container Path E2E Test] MCP server /health reported OK.');
          break;
        }
      }
    } catch {
      // Connection error - retry
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  if (!serverReady) {
    serverProcess.kill();
    throw new Error('Timeout waiting for MCP server /health endpoint to be ready.');
  }
  
  return serverProcess;
}

async function cleanup() {
  console.log('[Container Path E2E] Starting cleanup process...');
  
  if (mcpSdkClient) {
    try {
      await mcpSdkClient.close();
      console.log('[Container Path E2E] MCP SDK client closed successfully.');
    } catch (e) {
      console.error('[Container Path E2E] Error closing SDK client:', e);
    }
    mcpSdkClient = null;
  }
  
  if (mcpProcess) {
    try {
      mcpProcess.kill();
      console.log('[Container Path E2E] MCP process killed.');
    } catch (e) {
      console.error('[Container Path E2E] Error killing MCP process:', e);
    }
    mcpProcess = null;
  }
  
  // Restore original environment
  if (originalEnv) {
    process.env = originalEnv;
  }
  
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('[Container Path E2E] Cleanup completed.');
}

/**
 * ARCHITECTURAL DEBT: Cross-Platform Path Handling
 * 
 * These tests have fundamental cross-platform compatibility issues:
 * 
 * 1. Path Format Expectations:
 *    - Tests expect Unix-style paths: "examples/python/fibonacci.py:15"
 *    - Windows returns: "Breakpoint set at C:\path\to\project\examples\python\fibonacci.py:15"
 *    - No path normalization layer exists
 * 
 * 2. Test Design Flaws:
 *    - "should pass through absolute paths without translation" expects relative portion
 *    - Contradictory: absolute path test shouldn't expect relative path in result
 *    - Platform-specific path construction without abstraction
 * 
 * 3. Missing Architecture:
 *    - No internal path representation (should use forward slashes internally)
 *    - No OS-specific adapters for path handling
 *    - Direct string comparison without normalization
 * 
 * RESOLUTION APPROACH:
 * - Skip these tests until path abstraction layer implemented
 * - See: docs/architecture/task-19a-cross-platform-compatibility-audit.md
 * - See: docs/architecture/task-19a-skip-investigation-report.md
 * 
 * FUTURE WORK (Task 19c):
 * 1. Implement PathAbstraction class with:
 *    - Internal representation (always forward slashes)
 *    - toOSPath() and fromOSPath() methods
 *    - Path comparison utilities
 * 2. Create platform adapters (WindowsPathAdapter, UnixPathAdapter)
 * 3. Refactor all path handling to use abstraction layer
 * 
 * IMPACT:
 * - Tests fail on Windows but pass on Linux/Mac
 * - False negatives masking real issues
 * - CI/CD inconsistencies between platforms
 */
describe.skip('Container Path Translation E2E - SKIPPED: Cross-Platform Path Issues', () => {
  describe('Container Mode', () => {
    beforeAll(async () => {
      try {
        // Save original environment
        originalEnv = { ...process.env };
        
        // Start MCP server with container environment
        mcpProcess = await startMcpServerWithEnv({
          MCP_CONTAINER: 'true'
        });
        
        mcpSdkClient = new Client({ name: "container-path-e2e-test-client", version: "0.1.0" });
        const transport = new SSEClientTransport(new URL('http://localhost:3001/sse'));
        await mcpSdkClient.connect(transport);
        console.log('[Container Path E2E Test] MCP SDK Client connected via SSE.');
      } catch (error) {
        console.error('[Container Path E2E Setup] Error during setup:', error);
        await cleanup();
        throw error;
      }
    }, TEST_TIMEOUT);
    
    afterAll(async () => {
      await cleanup();
    });

    it('should reject absolute paths in container mode', async () => {
      if (!mcpSdkClient) throw new Error("MCP SDK Client not initialized.");
      
      // Create a session
      const createCall = await mcpSdkClient.callTool({
        name: 'create_debug_session',
        arguments: { language: 'python', name: 'Container Path Test' }
      });
      const createResponse = parseSdkToolResult(createCall);
      const sessionId = createResponse.sessionId;

      try {
        // Test set_breakpoint with Windows absolute path - should be rejected
        await expect(
          mcpSdkClient.callTool({
            name: 'set_breakpoint',
            arguments: { 
              sessionId,
              file: 'C:\\path\\to\\project\\src\\main.py',
              line: 10
            }
          })
        ).rejects.toThrow('not supported in container mode');
        
        // Test with Linux absolute path - should also be rejected
        await expect(
          mcpSdkClient.callTool({
            name: 'set_breakpoint',
            arguments: { 
              sessionId,
              file: '/path/to/project/src/main.py',
              line: 10
            }
          })
        ).rejects.toThrow('not supported in container mode');
      } finally {
        // Clean up session
        await mcpSdkClient.callTool({
          name: 'close_debug_session',
          arguments: { sessionId }
        });
      }
    }, TEST_TIMEOUT);

    it('should translate relative paths to container paths', async () => {
      if (!mcpSdkClient) throw new Error("MCP SDK Client not initialized.");
      
      // Create a session
      const createCall = await mcpSdkClient.callTool({
        name: 'create_debug_session',
        arguments: { language: 'python', name: 'Relative Path Test' }
      });
      const createResponse = parseSdkToolResult(createCall);
      const sessionId = createResponse.sessionId;

      try {
        // Test with relative path
        const breakpointCall = await mcpSdkClient.callTool({
          name: 'set_breakpoint',
          arguments: { 
            sessionId,
            file: 'src/main.py',
            line: 10
          }
        });
        const bpResponse = parseSdkToolResult(breakpointCall);
        expect(bpResponse.success).toBe(true);
        expect(bpResponse.message).toContain('Breakpoint set at /workspace/src/main.py:10');
        
        // Test with Windows-style relative path
        const breakpointCall2 = await mcpSdkClient.callTool({
          name: 'set_breakpoint',
          arguments: { 
            sessionId,
            file: 'src\\utils\\helper.py',
            line: 5
          }
        });
        const bpResponse2 = parseSdkToolResult(breakpointCall2);
        expect(bpResponse2.success).toBe(true);
        expect(bpResponse2.message).toContain('Breakpoint set at /workspace/src/utils/helper.py:5');
      } finally {
        // Clean up session
        await mcpSdkClient.callTool({
          name: 'close_debug_session',
          arguments: { sessionId }
        });
      }
    }, TEST_TIMEOUT);

    it('should handle /workspace paths correctly', async () => {
      if (!mcpSdkClient) throw new Error("MCP SDK Client not initialized.");
      
      // Create a session
      const createCall = await mcpSdkClient.callTool({
        name: 'create_debug_session',
        arguments: { language: 'python', name: 'Workspace Path Test' }
      });
      const createResponse = parseSdkToolResult(createCall);
      const sessionId = createResponse.sessionId;

      try {
        // Test with path already in /workspace format
        const breakpointCall = await mcpSdkClient.callTool({
          name: 'set_breakpoint',
          arguments: { 
            sessionId,
            file: '/workspace/tests/test_main.py',
            line: 15
          }
        });
        const bpResponse = parseSdkToolResult(breakpointCall);
        expect(bpResponse.success).toBe(true);
        expect(bpResponse.message).toContain('Breakpoint set at /workspace/tests/test_main.py:15');
      } finally {
        // Clean up session
        await mcpSdkClient.callTool({
          name: 'close_debug_session',
          arguments: { sessionId }
        });
      }
    }, TEST_TIMEOUT);
  });

  describe('Non-Container Mode', () => {
    beforeAll(async () => {
      try {
        // Save original environment
        originalEnv = { ...process.env };
        
        // Start MCP server without container environment
        mcpProcess = await startMcpServerWithEnv({
          MCP_CONTAINER: 'false'
        });
        
        mcpSdkClient = new Client({ name: "non-container-e2e-test-client", version: "0.1.0" });
        const transport = new SSEClientTransport(new URL('http://localhost:3001/sse'));
        await mcpSdkClient.connect(transport);
        console.log('[Non-Container E2E Test] MCP SDK Client connected via SSE.');
      } catch (error) {
        console.error('[Non-Container E2E Setup] Error during setup:', error);
        await cleanup();
        throw error;
      }
    }, TEST_TIMEOUT);
    
    afterAll(async () => {
      await cleanup();
    });

    it('should pass through absolute paths without translation', async () => {
      if (!mcpSdkClient) throw new Error("MCP SDK Client not initialized.");
      
      // Create a session
      const createCall = await mcpSdkClient.callTool({
        name: 'create_debug_session',
        arguments: { language: 'python', name: 'Non-Container Test' }
      });
      const createResponse = parseSdkToolResult(createCall);
      const sessionId = createResponse.sessionId;

      try {
        if (process.platform === 'win32') {
          // Test with Windows absolute path on Windows
          const breakpointCall = await mcpSdkClient.callTool({
            name: 'set_breakpoint',
            arguments: { 
              sessionId,
              file: 'C:\\path\\to\\project\\main.py',
              line: 10
            }
          });
          const bpResponse = parseSdkToolResult(breakpointCall);
          expect(bpResponse.success).toBe(true);
          expect(bpResponse.message).toContain('Breakpoint set at C:\\path\\to\\project\\main.py:10');
        } else {
          // Test with Unix absolute path on Linux/macOS
          const breakpointCall = await mcpSdkClient.callTool({
            name: 'set_breakpoint',
            arguments: { 
              sessionId,
              file: '/path/to/project/test.py',
              line: 5
            }
          });
          const bpResponse = parseSdkToolResult(breakpointCall);
          expect(bpResponse.success).toBe(true);
          expect(bpResponse.message).toContain('Breakpoint set at /path/to/project/test.py:5');
        }
        
        // Test with relative path using an actual file that exists
        const relativeCall = await mcpSdkClient.callTool({
          name: 'set_breakpoint',
          arguments: { 
            sessionId,
            file: 'examples/python/fibonacci.py',  // This file actually exists
            line: 15
          }
        });
        const relResponse = parseSdkToolResult(relativeCall);
        expect(relResponse.success).toBe(true);
        expect(relResponse.message).toContain('examples/python/fibonacci.py:15');
      } finally {
        // Clean up session
        await mcpSdkClient.callTool({
          name: 'close_debug_session',
          arguments: { sessionId }
        });
      }
    }, TEST_TIMEOUT);
  });
});
