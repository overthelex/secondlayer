#!/bin/bash
# Quick wrapper to convert test files to TXT

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Converting test files to TXT...${NC}"

npx ts-node --project tsconfig.test.json convert-test-files-to-txt.ts

echo -e "\n${GREEN}Done! Check test_data/ for .txt files${NC}"
