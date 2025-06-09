# MCP Debug Server - Development Setup Guide

This guide will help you set up your development environment for working on the MCP Debug Server project.

## Prerequisites

### Required Software

1. **Node.js** (v16.0.0 or higher)
   - Download from [nodejs.org](https://nodejs.org/)
   - Verify installation: `node --version`

2. **npm** (v7.0.0 or higher, usually comes with Node.js)
   - Verify installation: `npm --version`

3. **Git**
   - Download from [git-scm.com](https://git-scm.com/)
   - Verify installation: `git --version`

4. **Python** (v3.7 or higher) - For testing Python debugging
   - Download from [python.org](https://www.python.org/)
   - Verify installation: `python --version`

5. **Visual Studio Code** (Recommended)
   - Download from [code.visualstudio.com](https://code.visualstudio.com/)
   - Install recommended extensions (see below)

### Optional Software

1. **Docker** - For testing Docker deployment
   - Download from [docker.com](https://www.docker.com/)
   - Verify installation: `docker --version`

## Initial Setup

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/debug-mcp-server.git
cd debug-mcp-server
```

### 2. Install Dependencies

```bash
npm install
```

This will install all required dependencies specified in `package.json`.

### 3. Install Python debugpy

The server requires `debugpy` for Python debugging:

```bash
pip install debugpy
```

Or if using pip3:

```bash
pip3 install debugpy
```

### 4. Build the Project

```bash
npm run build
```

This compiles TypeScript files to JavaScript in the `dist/` directory.

### 5. Verify Installation

Run the test suite to ensure everything is set up correctly:

```bash
npm test
```

All tests should pass. If any fail, check the error messages for missing dependencies.

## Development Workflow

### Directory Structure

```
debug-mcp-server/
├── src/                    # Source code
│   ├── session/           # Session management
│   ├── proxy/             # Proxy management
│   ├── dap-core/          # DAP protocol core
│   ├── interfaces/        # TypeScript interfaces
│   ├── implementations/   # Concrete implementations
│   └── utils/             # Utilities
├── tests/                  # Test files
│   ├── unit/              # Unit tests
│   ├── integration/       # Integration tests
│   └── e2e/               # End-to-end tests
├── docs/                   # Documentation
├── examples/               # Example scripts
├── dist/                   # Compiled output
└── coverage/              # Test coverage reports
```

### Common Commands

```bash
# Development build (watch mode)
npm run dev

# Production build
npm run build

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# View coverage report
npm run coverage:report

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Type checking
npm run type-check
```

### Running the Server Locally

#### STDIO Mode (Default)

```bash
node dist/index.js
```

#### TCP Mode

```bash
node dist/index.js --transport tcp --port 6111
```

#### With Debug Logging

```bash
DEBUG=* node dist/index.js
```

## VS Code Setup

### Recommended Extensions

Create `.vscode/extensions.json`:

```json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "vitest.explorer",
    "ms-vscode.vscode-typescript-next",
    "streetsidesoftware.code-spell-checker",
    "eamodio.gitlens"
  ]
}
```

### Launch Configuration

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Server (STDIO)",
      "skipFiles": ["<node_internals>/**"],
      "program": "${workspaceFolder}/dist/index.js",
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Server (TCP)",
      "skipFiles": ["<node_internals>/**"],
      "program": "${workspaceFolder}/dist/index.js",
      "args": ["--transport", "tcp", "--port", "6111"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Tests",
      "skipFiles": ["<node_internals>/**"],
      "program": "${workspaceFolder}/node_modules/vitest/vitest.mjs",
      "args": ["run", "${file}"],
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal"
    }
  ]
}
```

### Tasks Configuration

Create `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "build",
      "group": {
        "kind": "build",
        "isDefault": true
      },
      "problemMatcher": "$tsc",
      "label": "npm: build"
    },
    {
      "type": "npm",
      "script": "dev",
      "group": "build",
      "problemMatcher": "$tsc-watch",
      "isBackground": true,
      "label": "npm: dev"
    },
    {
      "type": "npm",
      "script": "test",
      "group": {
        "kind": "test",
        "isDefault": true
      },
      "label": "npm: test"
    }
  ]
}
```

## Environment Variables

### Development Environment

Create a `.env` file for development:

```bash
# Logging
LOG_LEVEL=debug
LOG_FILE=./logs/debug.log

# Python
PYTHON_PATH=python

# Server
MCP_SERVER_PORT=6111

# Testing
TEST_TIMEOUT=30000
```

### Available Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging level (error, warn, info, debug) | `info` |
| `LOG_FILE` | Path to log file | None (console only) |
| `PYTHON_PATH` | Path to Python executable | Auto-detected |
| `MCP_SERVER_PORT` | TCP port for server | `6111` |
| `DEBUG` | Enable debug output | `false` |

## Troubleshooting Setup Issues

### Node.js Issues

**Problem**: `npm install` fails with permission errors

**Solution**:
```bash
# On Unix/macOS
sudo npm install -g npm@latest

# On Windows (run as Administrator)
npm install -g npm@latest
```

**Problem**: Node version is too old

**Solution**: Use nvm (Node Version Manager):
```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Install and use Node 18
nvm install 18
nvm use 18
```

### Python Issues

**Problem**: `debugpy` not found

**Solution**:
```bash
# Ensure pip is up to date
python -m pip install --upgrade pip

# Install debugpy
python -m pip install debugpy

# Verify installation
python -c "import debugpy; print(debugpy.__version__)"
```

**Problem**: Multiple Python versions

**Solution**: Set `PYTHON_PATH` environment variable:
```bash
# Unix/macOS
export PYTHON_PATH=/usr/bin/python3

# Windows
set PYTHON_PATH=C:\Python39\python.exe
```

### Build Issues

**Problem**: TypeScript compilation errors

**Solution**:
```bash
# Clean and rebuild
npm run clean
npm install
npm run build
```

**Problem**: Module resolution errors

**Solution**:
```bash
# Clear Node.js cache
npm cache clean --force

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

## Development Best Practices

### 1. Code Style

The project uses ESLint and Prettier for code formatting:

```bash
# Check code style
npm run lint

# Fix automatically
npm run lint:fix
```

### 2. Commit Messages

Follow conventional commit format:
```
type(scope): subject

body

footer
```

Examples:
```
feat(session): add timeout configuration
fix(proxy): handle connection errors properly
docs(api): update endpoint documentation
test(integration): add Python 3.11 tests
```

### 3. Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation updates
- `test/description` - Test additions/fixes
- `refactor/description` - Code refactoring

### 4. Testing

Always write tests for new features:

```typescript
// Unit test example
describe('MyComponent', () => {
  it('should handle specific case', () => {
    // Arrange
    const component = new MyComponent(mockDependencies);
    
    // Act
    const result = component.doSomething();
    
    // Assert
    expect(result).toBe(expectedValue);
  });
});
```

### 5. Documentation

Update documentation when adding features:
- API changes → Update component docs
- New patterns → Add to pattern docs
- User-facing changes → Update README

## Next Steps

1. Read the [Testing Guide](./testing-guide.md) to understand the test suite
2. Review the [Architecture Overview](../architecture/system-overview.md)
3. Check [Contributing Guidelines](../../CONTRIBUTING.md) before submitting PRs
4. Join the development discussion on [GitHub Issues](https://github.com/your-username/debug-mcp-server/issues)

## Getting Help

- **Documentation**: Check the `docs/` directory
- **Examples**: See `examples/` for usage examples
- **Issues**: Report bugs on GitHub
- **Discussions**: Use GitHub Discussions for questions

Happy coding! 🚀
