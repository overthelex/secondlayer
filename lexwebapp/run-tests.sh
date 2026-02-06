#!/bin/bash
#
# Test Runner Script for MCP Streaming Integration
# Run this script to install dependencies and execute tests
#

set -e  # Exit on error

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  MCP Streaming Integration - Test Runner                  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js not found!${NC}"
    echo "Please install Node.js 20+ from https://nodejs.org/"
    exit 1
fi

echo -e "${GREEN}✓ Node.js found:${NC} $(node --version)"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm not found!${NC}"
    echo "Please install npm"
    exit 1
fi

echo -e "${GREEN}✓ npm found:${NC} $(npm --version)"
echo ""

# Navigate to lexwebapp directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "📂 Working directory: $SCRIPT_DIR"
echo ""

# Step 1: Install dependencies
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 1: Installing dependencies..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}→ Running npm install...${NC}"
    npm install --legacy-peer-deps
    echo -e "${GREEN}✓ Dependencies installed${NC}"
else
    echo -e "${GREEN}✓ node_modules exists, checking for updates...${NC}"
    npm install --legacy-peer-deps
fi

echo ""

# Step 2: Run TypeScript type checking
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 2: TypeScript type checking..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if npx tsc --noEmit; then
    echo -e "${GREEN}✓ TypeScript compilation successful${NC}"
else
    echo -e "${RED}✗ TypeScript errors found${NC}"
    echo "Please fix TypeScript errors before running tests"
    exit 1
fi

echo ""

# Step 3: Run unit tests
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 3: Running unit tests..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if npm test; then
    echo ""
    echo -e "${GREEN}✓ All tests passed!${NC}"
else
    echo ""
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi

echo ""

# Step 4: Generate coverage report
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 4: Generating coverage report..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

npm run test:coverage

echo ""

# Summary
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                    Test Summary                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo -e "${GREEN}✓ TypeScript compilation successful${NC}"
echo -e "${GREEN}✓ All unit tests passed${NC}"
echo -e "${GREEN}✓ Coverage report generated${NC}"
echo ""
echo "Coverage report: file://$(pwd)/coverage/index.html"
echo ""
echo -e "${GREEN}Ready for deployment! 🚀${NC}"
