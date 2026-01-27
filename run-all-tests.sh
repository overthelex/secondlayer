#!/bin/bash

##############################################################################
# Run All Integration Tests for SecondLayer MCP Servers
##############################################################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║    SecondLayer MCP Integration Tests Runner           ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if services are running
echo -e "${YELLOW}📋 Checking if services are running...${NC}"

if ! curl -s http://localhost:3000/health > /dev/null; then
    echo -e "${RED}❌ SecondLayer backend is not running on port 3000${NC}"
    echo -e "${YELLOW}   Start it with: cd deployment && ./manage-gateway.sh start local${NC}"
    exit 1
fi

if ! curl -s http://localhost:3001/health > /dev/null; then
    echo -e "${RED}❌ RADA MCP is not running on port 3001${NC}"
    echo -e "${YELLOW}   Start it with: cd deployment && ./manage-gateway.sh start local${NC}"
    exit 1
fi

echo -e "${GREEN}✅ All services are running${NC}"
echo ""

# Export test environment variables
export TEST_BASE_URL="http://localhost:3000"
export TEST_API_KEY="test-key-123"
export RADA_TEST_BASE_URL="http://localhost:3001"
export RADA_TEST_API_KEY="test-key-123"

# Function to run tests for a service
run_tests() {
    local service=$1
    local test_file=$2
    local description=$3

    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}Testing: ${description}${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo ""

    cd "${service}"

    if [ ! -f "${test_file}" ]; then
        echo -e "${YELLOW}⚠️  Test file not found: ${test_file}${NC}"
        cd ..
        return 1
    fi

    # Run tests with Jest
    if npm test -- "${test_file}" --verbose; then
        echo -e "${GREEN}✅ ${description} tests passed${NC}"
        cd ..
        return 0
    else
        echo -e "${RED}❌ ${description} tests failed${NC}"
        cd ..
        return 1
    fi
}

# Track test results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Run SecondLayer backend tests
echo -e "${YELLOW}🧪 Running SecondLayer Backend Tests...${NC}"
echo ""

if run_tests "mcp_backend" "src/api/__tests__/all-tools-integration.test.ts" "SecondLayer MCP (34 tools)"; then
    ((PASSED_TESTS++))
else
    ((FAILED_TESTS++))
fi
((TOTAL_TESTS++))

echo ""
echo ""

# Run RADA MCP tests
echo -e "${YELLOW}🧪 Running RADA MCP Tests...${NC}"
echo ""

if run_tests "mcp_rada" "src/api/__tests__/all-rada-tools-integration.test.ts" "RADA MCP (4 tools)"; then
    ((PASSED_TESTS++))
else
    ((FAILED_TESTS++))
fi
((TOTAL_TESTS++))

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}           Test Summary                                 ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "Total Test Suites: ${TOTAL_TESTS}"
echo -e "${GREEN}Passed: ${PASSED_TESTS}${NC}"
if [ $FAILED_TESTS -gt 0 ]; then
    echo -e "${RED}Failed: ${FAILED_TESTS}${NC}"
fi
echo ""

if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}🎉 All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Some tests failed${NC}"
    exit 1
fi
