#!/bin/bash

# ============================================================================
# SecondLayer Local Deployment - Test Runner
# ============================================================================
# Runs all tests for locally deployed services
# Usage: ./run-local-tests.sh [options]
#
# Options:
#   --quick       Run only smoke tests
#   --backend     Run only backend tests
#   --rada        Run only RADA tests
#   --verbose     Show detailed output
#   --no-wait     Skip waiting for services
# ============================================================================

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
QUICK_MODE=false
BACKEND_ONLY=false
RADA_ONLY=false
VERBOSE=false
WAIT_FOR_SERVICES=true

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --quick)
      QUICK_MODE=true
      shift
      ;;
    --backend)
      BACKEND_ONLY=true
      shift
      ;;
    --rada)
      RADA_ONLY=true
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --no-wait)
      WAIT_FOR_SERVICES=false
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --quick       Run only smoke tests"
      echo "  --backend     Run only backend tests"
      echo "  --rada        Run only RADA tests"
      echo "  --verbose     Show detailed output"
      echo "  --no-wait     Skip waiting for services"
      echo "  -h, --help    Show this help message"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

# ============================================================================
# Helper Functions
# ============================================================================

print_header() {
  echo ""
  echo -e "${BLUE}============================================================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}============================================================================${NC}"
  echo ""
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
  echo -e "${BLUE}→ $1${NC}"
}

# Check if service is running
check_service() {
  local service_name=$1
  local port=$2

  if docker ps --format '{{.Names}}' | grep -q "^${service_name}$"; then
    print_success "$service_name is running"
    return 0
  else
    print_error "$service_name is not running"
    return 1
  fi
}

# Wait for service health check
wait_for_service() {
  local service_name=$1
  local url=$2
  local max_attempts=30
  local attempt=0

  print_info "Waiting for $service_name to be ready..."

  while [ $attempt -lt $max_attempts ]; do
    if curl -s -f "$url" > /dev/null 2>&1; then
      print_success "$service_name is ready"
      return 0
    fi

    attempt=$((attempt + 1))
    echo -n "."
    sleep 2
  done

  echo ""
  print_error "$service_name failed to become ready after ${max_attempts} attempts"
  return 1
}

# Run tests from host (not in container, since containers don't have dev dependencies)
run_tests_from_host() {
  local project_dir=$1
  local test_path=$2
  local test_name=$3

  print_info "Running $test_name..."

  # Save current directory
  local original_dir=$(pwd)

  # Change to project directory
  cd "$project_dir" || return 1

  if [ "$VERBOSE" = true ]; then
    npm test -- "$test_path"
  else
    npm test -- "$test_path" 2>&1 | grep -E "(PASS|FAIL|Tests:|Test Suites:)" || true
  fi

  local exit_code=${PIPESTATUS[0]}

  # Change back to original directory
  cd "$original_dir" || return 1

  if [ $exit_code -eq 0 ]; then
    print_success "$test_name passed"
    return 0
  else
    print_error "$test_name failed"
    return 1
  fi
}

# ============================================================================
# Main Script
# ============================================================================

print_header "SecondLayer Local Deployment - Test Runner"

# Navigate to project root
cd "$(dirname "$0")/.."

# Check if services are running
print_header "Checking Services"

SERVICES_OK=true

if ! check_service "secondlayer-app-local" "3000"; then
  SERVICES_OK=false
fi

if ! check_service "document-service-local" "3002"; then
  SERVICES_OK=false
fi

if ! check_service "secondlayer-postgres-local" "5432"; then
  SERVICES_OK=false
fi

if ! check_service "secondlayer-redis-local" "6379"; then
  SERVICES_OK=false
fi

# Check RADA service (optional)
RADA_RUNNING=false
if docker ps --format '{{.Names}}' | grep -q "^rada-mcp-app-local$"; then
  check_service "rada-mcp-app-local" "3001"
  RADA_RUNNING=true
fi

if [ "$SERVICES_OK" = false ]; then
  print_error "Some required services are not running"
  print_info "Start services with: ./manage-gateway.sh start local"
  exit 1
fi

# Wait for services to be ready
if [ "$WAIT_FOR_SERVICES" = true ]; then
  print_header "Waiting for Services to be Ready"

  wait_for_service "Main Backend" "http://localhost:3000/health" || exit 1
  wait_for_service "Document Service" "http://localhost:3002/health" || exit 1

  if [ "$RADA_RUNNING" = true ] && [ "$BACKEND_ONLY" = false ]; then
    wait_for_service "RADA MCP" "http://localhost:3001/health" || exit 1
  fi
fi

# Initialize test results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# ============================================================================
# Run Backend Tests
# ============================================================================

if [ "$RADA_ONLY" = false ]; then
  print_header "Running Main Backend Tests"

  if [ "$QUICK_MODE" = true ]; then
    # Quick mode - only smoke tests
    print_info "Quick mode: Running smoke tests only"

    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if run_tests_from_host "./mcp_backend" "smoke-test-all-tools.test.ts" "Backend Smoke Tests"; then
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
  else
    # Full test suite
    print_info "Running full backend test suite"

    # Smoke tests
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if run_tests_from_host "./mcp_backend" "smoke-test-all-tools.test.ts" "Backend Smoke Tests"; then
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi

    # Integration tests
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if run_tests_from_host "./mcp_backend" "all-tools-integration.test.ts" "Backend Integration Tests"; then
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi

    # Document analysis E2E
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if run_tests_from_host "./mcp_backend" "document-analysis-e2e.test.ts" "Document Service E2E Tests"; then
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi

    # Due diligence tools
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if run_tests_from_host "./mcp_backend" "due-diligence-tools.test.ts" "Due Diligence Tools Tests"; then
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi

    # Legal advice tests
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if run_tests_from_host "./mcp_backend" "get-legal-advice-cpc-gpc.test.ts" "Legal Advice Tests"; then
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi

    # Legal precedents tests
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if run_tests_from_host "./mcp_backend" "search-legal-precedents.test.ts" "Legal Precedents Tests"; then
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi

    # ZO Adapter tests
    print_info "Running ZO Adapter tests..."
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    original_dir=$(pwd)
    cd ./mcp_backend
    if npm test -- "zo-adapter" > /dev/null 2>&1; then
      print_success "ZO Adapter tests passed"
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      print_warning "ZO Adapter tests failed or skipped"
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
    cd "$original_dir"
  fi
fi

# ============================================================================
# Run RADA Tests
# ============================================================================

if [ "$RADA_RUNNING" = true ] && [ "$BACKEND_ONLY" = false ]; then
  print_header "Running RADA MCP Tests"

  if [ "$QUICK_MODE" = true ]; then
    # Quick mode - only smoke tests
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if run_tests_from_host "./mcp_rada" "smoke-test-rada-tools.test.ts" "RADA Smoke Tests"; then
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
  else
    # Full test suite
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if run_tests_from_host "./mcp_rada" "smoke-test-rada-tools.test.ts" "RADA Smoke Tests"; then
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi

    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if run_tests_from_host "./mcp_rada" "all-rada-tools-integration.test.ts" "RADA Integration Tests"; then
      PASSED_TESTS=$((PASSED_TESTS + 1))
    else
      FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
  fi
elif [ "$RADA_ONLY" = true ]; then
  print_error "RADA service is not running. Cannot run RADA tests."
  exit 1
fi

# ============================================================================
# Summary
# ============================================================================

print_header "Test Results Summary"

echo ""
echo -e "${BLUE}Total Test Suites: ${NC}$TOTAL_TESTS"
echo -e "${GREEN}Passed: ${NC}$PASSED_TESTS"
echo -e "${RED}Failed: ${NC}$FAILED_TESTS"
echo ""

if [ $FAILED_TESTS -eq 0 ]; then
  print_success "All tests passed! ✨"
  echo ""
  exit 0
else
  print_error "Some tests failed. Check the output above for details."
  echo ""
  print_info "To see detailed output, run with --verbose flag:"
  print_info "  ./run-local-tests.sh --verbose"
  echo ""
  exit 1
fi
