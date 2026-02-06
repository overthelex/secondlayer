#!/bin/bash
#
# Setup Verification Script
# Verifies that all files and configurations are correct
#

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  MCP Streaming Integration - Setup Verification           ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

ERRORS=0
WARNINGS=0

check_file() {
    local file=$1
    local description=$2

    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $description: ${BLUE}$file${NC}"
    else
        echo -e "${RED}✗${NC} $description: $file ${RED}(MISSING)${NC}"
        ((ERRORS++))
    fi
}

check_directory() {
    local dir=$1
    local description=$2

    if [ -d "$dir" ]; then
        echo -e "${GREEN}✓${NC} $description: ${BLUE}$dir${NC}"
    else
        echo -e "${RED}✗${NC} $description: $dir ${RED}(MISSING)${NC}"
        ((ERRORS++))
    fi
}

check_content() {
    local file=$1
    local pattern=$2
    local description=$3

    if grep -q "$pattern" "$file" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} $description"
    else
        echo -e "${YELLOW}⚠${NC} $description ${YELLOW}(WARNING)${NC}"
        ((WARNINGS++))
    fi
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1. Core Files"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_file "package.json" "Package configuration"
check_file "vite.config.ts" "Vite configuration"
check_file "vitest.config.ts" "Vitest configuration"
check_file "tsconfig.json" "TypeScript configuration"
check_file ".env.staging" "Staging environment"
check_file "Dockerfile" "Docker configuration"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "2. Source Files - Types"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_file "src/types/api/sse.ts" "SSE types"
check_file "src/types/api/mcp-tools.ts" "MCP tools types"
check_file "src/types/api/index.ts" "API types index"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "3. Source Files - Services"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_file "src/services/api/SSEClient.ts" "SSE Client service"
check_file "src/services/api/MCPService.ts" "MCP Service"
check_file "src/services/api/LegalService.ts" "Legacy Legal Service"
check_file "src/services/index.ts" "Services index"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "4. Source Files - Hooks & Stores"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_file "src/hooks/useMCPTool.ts" "useMCPTool hook"
check_file "src/stores/chatStore.ts" "Chat store"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "5. Test Files"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_file "src/__tests__/setup.ts" "Test setup"
check_file "src/services/api/__tests__/SSEClient.test.ts" "SSEClient tests"
check_file "src/services/api/__tests__/MCPService.test.ts" "MCPService tests"
check_file "src/hooks/__tests__/useMCPTool.test.tsx" "useMCPTool tests"
check_file "src/stores/__tests__/chatStore.test.ts" "chatStore tests"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "6. Documentation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_file "docs/MCP_STREAMING_INTEGRATION.md" "Integration guide"
check_file "docs/QUICK_START.md" "Quick start guide"
check_file "docs/INDEX.md" "Documentation index"
check_file "BUILD_SUMMARY.md" "Build summary"
check_file "TEST_INSTRUCTIONS.md" "Test instructions"
check_file "src/__tests__/README.md" "Testing guide"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "7. Scripts"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_file "run-tests.sh" "Test runner script"
check_file "verify-setup.sh" "Verification script"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "8. Package.json Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_content "package.json" '"test":' "Test script defined"
check_content "package.json" '"test:watch":' "Test watch script defined"
check_content "package.json" '"test:coverage":' "Test coverage script defined"
check_content "package.json" '"build:staging":' "Staging build script defined"
check_content "package.json" '"vitest":' "Vitest dependency"
check_content "package.json" '"@testing-library/react":' "React Testing Library"
check_content "package.json" '"jsdom":' "jsdom dependency"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "9. Environment Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_content ".env.staging" "VITE_API_URL" "API URL configured"
check_content ".env.staging" "VITE_API_KEY" "API key configured"
check_content ".env.staging" "VITE_ENABLE_SSE_STREAMING" "SSE streaming enabled"
check_content ".env.staging" "VITE_ENABLE_ALL_MCP_TOOLS" "All tools enabled"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "10. File Count Verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

TYPES_COUNT=$(find src/types/api -name "*.ts" 2>/dev/null | wc -l)
SERVICES_COUNT=$(find src/services/api -name "*.ts" ! -path "*/__tests__/*" 2>/dev/null | wc -l)
TEST_COUNT=$(find src -name "*.test.ts" -o -name "*.test.tsx" 2>/dev/null | wc -l)
DOCS_COUNT=$(find docs -name "*.md" 2>/dev/null | wc -l)

echo -e "${GREEN}✓${NC} Type files: ${BLUE}$TYPES_COUNT${NC} (expected: 3)"
echo -e "${GREEN}✓${NC} Service files: ${BLUE}$SERVICES_COUNT${NC} (expected: 4+)"
echo -e "${GREEN}✓${NC} Test files: ${BLUE}$TEST_COUNT${NC} (expected: 4)"
echo -e "${GREEN}✓${NC} Documentation files: ${BLUE}$DOCS_COUNT${NC} (expected: 3+)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed!${NC}"
    echo ""
    echo "Setup is complete and ready for testing."
    echo ""
    echo "Next steps:"
    echo "  1. Run tests: ./run-tests.sh"
    echo "  2. Build staging: npm run build:staging"
    echo "  3. Deploy: cd ../deployment && docker compose -f docker-compose.stage.yml up -d"
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠ Setup complete with $WARNINGS warnings${NC}"
    echo ""
    echo "You can proceed, but review the warnings above."
    exit 0
else
    echo -e "${RED}✗ Setup incomplete: $ERRORS errors, $WARNINGS warnings${NC}"
    echo ""
    echo "Please fix the errors above before proceeding."
    exit 1
fi
