#!/bin/bash
# Quick test script for batch processing implementation

set -e

echo "🧪 Testing Batch Processing Implementation"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check Node.js version
echo "1️⃣  Checking Node.js version..."
NODE_VERSION=$(node -v)
echo "   Node.js: $NODE_VERSION"
if [[ ! "$NODE_VERSION" =~ ^v(20|21|22)\. ]]; then
    echo -e "${RED}   ✗ Node.js 20+ required${NC}"
    exit 1
fi
echo -e "${GREEN}   ✓ Node.js version OK${NC}"
echo ""

# Check if backend is running
echo "2️⃣  Checking backend availability..."
if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo -e "${GREEN}   ✓ Backend is running${NC}"
else
    echo -e "${RED}   ✗ Backend is not running${NC}"
    echo "   Start it with: cd mcp_backend && npm run dev:http"
    exit 1
fi
echo ""

# Check API key
echo "3️⃣  Checking API key..."
if [ -z "$SECONDLAYER_API_KEY" ]; then
    echo -e "${YELLOW}   ⚠️  SECONDLAYER_API_KEY not set${NC}"
    echo "   Set it with: export SECONDLAYER_API_KEY=your-key-here"
    exit 1
fi
echo -e "${GREEN}   ✓ API key is set${NC}"
echo ""

# Check if batch tool is registered
echo "4️⃣  Checking if batch_process_documents tool is registered..."
TOOLS=$(curl -s -H "Authorization: Bearer $SECONDLAYER_API_KEY" \
    http://localhost:3000/api/tools | jq -r '.tools[].name' | grep batch_process_documents || true)

if [ -z "$TOOLS" ]; then
    echo -e "${RED}   ✗ batch_process_documents tool not found${NC}"
    echo "   Make sure backend is rebuilt: cd mcp_backend && npm run build"
    exit 1
fi
echo -e "${GREEN}   ✓ batch_process_documents tool is registered${NC}"
echo ""

# Create test files
echo "5️⃣  Creating test files..."
TEST_DIR="./test-batch-docs"
mkdir -p "$TEST_DIR"

# Create 5 simple text files (mock PDFs)
for i in {1..5}; do
    cat > "$TEST_DIR/test-doc-$i.txt" << EOF
Test Document $i
================

This is a test document for batch processing.

Content:
- Section 1: Introduction
- Section 2: Main content
- Section 3: Conclusion

Date: $(date)
EOF
done

echo "   Created 5 test files in $TEST_DIR/"
echo -e "${GREEN}   ✓ Test files created${NC}"
echo ""

# Test 1: Check if script exists
echo "6️⃣  Checking batch processing script..."
if [ ! -f "./scripts/batch-process-documents.ts" ]; then
    echo -e "${RED}   ✗ Script not found${NC}"
    exit 1
fi
echo -e "${GREEN}   ✓ Script exists${NC}"
echo ""

# Test 2: Dry run (check if script can be executed)
echo "7️⃣  Testing script execution (dry run)..."
if npm run batch-process -- --help > /dev/null 2>&1; then
    echo -e "${GREEN}   ✓ Script can be executed${NC}"
else
    echo -e "${RED}   ✗ Script execution failed${NC}"
    echo "   Install dependencies: npm run install:all"
    exit 1
fi
echo ""

# Summary
echo "=========================================="
echo -e "${GREEN}✅ All checks passed!${NC}"
echo ""
echo "You're ready to process documents!"
echo ""
echo "Try these commands:"
echo ""
echo "1. Test with mock files (5 files):"
echo "   npm run batch-process -- \\"
echo "     --input $TEST_DIR \\"
echo "     --operations parse,summarize \\"
echo "     --concurrency 2"
echo ""
echo "2. Process your real documents:"
echo "   npm run batch-process -- \\"
echo "     --input ./your-documents \\"
echo "     --operations parse,summarize \\"
echo "     --concurrency 5"
echo ""
echo "3. See all examples:"
echo "   ./examples/batch-processing-examples.sh"
echo ""
echo "📚 Documentation:"
echo "   - Quick Start: BATCH_PROCESSING_QUICKSTART.md"
echo "   - Full Guide: docs/BATCH_PROCESSING_GUIDE.md"
echo "   - Main README: BATCH_PROCESSING_README.md"
echo ""
