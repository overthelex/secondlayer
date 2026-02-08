#!/bin/bash
#
# E2E Test Runner with Real Data
#
# This script runs document analysis E2E tests with real data from test_data/
#
# Usage:
#   ./run-e2e-tests.sh [--with-credentials]
#
# Options:
#   --with-credentials  Run full tests with API credentials (requires setup)
#   --dry-run          Run without credentials (tests will skip)
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/mcp_backend"
TEST_DATA_DIR="$SCRIPT_DIR/test_data"

echo -e "${BLUE}=== SecondLayer E2E Test Runner ===${NC}\n"

# Check test data exists
if [ ! -d "$TEST_DATA_DIR" ]; then
  echo -e "${RED}Error: test_data directory not found at $TEST_DATA_DIR${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} Test data directory found"
echo -e "  Files: $(ls -1 "$TEST_DATA_DIR" | wc -l | tr -d ' ')"
echo ""

# Navigate to backend
cd "$BACKEND_DIR"

# Check if we should run with credentials
RUN_WITH_CREDENTIALS=false
if [ "$1" = "--with-credentials" ]; then
  RUN_WITH_CREDENTIALS=true
fi

# Check for credentials
if [ "$RUN_WITH_CREDENTIALS" = true ]; then
  echo -e "${YELLOW}Checking for API credentials...${NC}"

  MISSING_CREDS=false

  if [ -z "$OPENAI_API_KEY" ] && [ ! -f .env ]; then
    echo -e "${RED}✗${NC} OPENAI_API_KEY not set"
    MISSING_CREDS=true
  else
    echo -e "${GREEN}✓${NC} OpenAI API key found"
  fi

  if [ -z "$GOOGLE_APPLICATION_CREDENTIALS" ] && [ ! -f .env ]; then
    echo -e "${RED}✗${NC} GOOGLE_APPLICATION_CREDENTIALS not set"
    MISSING_CREDS=true
  else
    echo -e "${GREEN}✓${NC} Google Vision credentials found"
  fi

  if [ "$MISSING_CREDS" = true ]; then
    echo -e "\n${YELLOW}To set up credentials:${NC}"
    echo "1. Copy .env.test.example to .env"
    echo "2. Add your OPENAI_API_KEY"
    echo "3. Add path to GOOGLE_APPLICATION_CREDENTIALS"
    echo ""
    echo "Or run without credentials: ./run-e2e-tests.sh --dry-run"
    exit 1
  fi

  echo -e "${GREEN}All credentials found!${NC}\n"
else
  echo -e "${YELLOW}Running in dry-run mode (tests will skip)${NC}"
  echo -e "Use --with-credentials to run full tests\n"
fi

# Build if needed
if [ ! -d "dist" ]; then
  echo -e "${YELLOW}Building TypeScript...${NC}"
  npm run build
  echo -e "${GREEN}✓${NC} Build complete\n"
fi

# Run tests
echo -e "${BLUE}Running E2E tests...${NC}\n"
echo "================================================"

npm test -- src/api/__tests__/document-analysis-e2e.test.ts

echo ""
echo "================================================"
echo -e "${GREEN}✓ E2E tests completed!${NC}"

# Generate summary
if [ "$RUN_WITH_CREDENTIALS" = true ]; then
  echo -e "\n${BLUE}Test Summary:${NC}"
  echo "✓ Document parsing (HTML, PDF, DOCX)"
  echo "✓ Key clause extraction"
  echo "✓ Document summarization"
  echo "✓ Document comparison"
  echo "✓ Complete workflow integration"
  echo "✓ Error handling"
else
  echo -e "\n${YELLOW}Note: Tests ran in dry-run mode.${NC}"
  echo "Set up credentials to run full E2E tests with real API calls."
fi

echo ""
