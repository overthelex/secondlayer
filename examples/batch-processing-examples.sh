#!/bin/bash
# Batch Processing Examples
# SecondLayer MCP - Document Processing at Scale

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}SecondLayer Batch Processing Examples${NC}"
echo -e "${BLUE}========================================${NC}\n"

# Check if API key is set
if [ -z "$SECONDLAYER_API_KEY" ]; then
    echo -e "${YELLOW}⚠️  SECONDLAYER_API_KEY not set${NC}"
    echo "Set it with: export SECONDLAYER_API_KEY=your-key-here"
    exit 1
fi

# ============================================
# Example 1: Process 4000 Images (OCR only)
# ============================================
echo -e "\n${GREEN}Example 1: Process 4000 Images with OCR${NC}"
echo "=========================================="
echo "Time: 2-4 hours | Cost: ~\$6.00"
echo ""
echo "Command:"
echo "npm run batch-process -- \\"
echo "  --input ./scanned-documents \\"
echo "  --operations parse \\"
echo "  --concurrency 10 \\"
echo "  --output ./image-results"
echo ""

# ============================================
# Example 2: Process 1000 PDFs with Summarization
# ============================================
echo -e "\n${GREEN}Example 2: Process 1000 PDFs with Summarization${NC}"
echo "=================================================="
echo "Time: 1-2 hours | Cost: ~\$1.80"
echo ""
echo "Command:"
echo "npm run batch-process -- \\"
echo "  --input ./pdf-documents \\"
echo "  --operations parse,summarize \\"
echo "  --concurrency 5 \\"
echo "  --summarize-level standard \\"
echo "  --output ./pdf-results"
echo ""

# ============================================
# Example 3: Full Contract Analysis
# ============================================
echo -e "\n${GREEN}Example 3: Full Contract Analysis${NC}"
echo "===================================="
echo "Time: 45-90 min (500 docs) | Cost: ~\$1.05"
echo ""
echo "Command:"
echo "npm run batch-process -- \\"
echo "  --input ./contracts \\"
echo "  --operations parse,extract_clauses,summarize \\"
echo "  --concurrency 5 \\"
echo "  --summarize-level standard \\"
echo "  --retry 3 \\"
echo "  --output ./contract-analysis"
echo ""

# ============================================
# Example 4: Quick Scan (Testing)
# ============================================
echo -e "\n${GREEN}Example 4: Quick Scan (Testing)${NC}"
echo "=================================="
echo "Time: <1 min | Cost: ~\$0.01"
echo ""
echo "Command:"
echo "npm run batch-process -- \\"
echo "  --input ./test-docs \\"
echo "  --operations parse,summarize \\"
echo "  --concurrency 5 \\"
echo "  --chunk-size 10 \\"
echo "  --summarize-level quick"
echo ""

# ============================================
# Example 5: High-Priority Rush Job
# ============================================
echo -e "\n${GREEN}Example 5: High-Priority Rush Job${NC}"
echo "===================================="
echo "Time: Fastest | Cost: Higher (more API calls)"
echo ""
echo "Command:"
echo "npm run batch-process -- \\"
echo "  --input ./urgent-docs \\"
echo "  --operations parse,summarize \\"
echo "  --concurrency 20 \\"
echo "  --chunk-size 50 \\"
echo "  --summarize-level quick"
echo ""

# ============================================
# Example 6: Deep Analysis (Quality over Speed)
# ============================================
echo -e "\n${GREEN}Example 6: Deep Analysis (Quality over Speed)${NC}"
echo "==============================================="
echo "Time: Slowest | Cost: Highest (GPT-4o)"
echo ""
echo "Command:"
echo "npm run batch-process -- \\"
echo "  --input ./important-contracts \\"
echo "  --operations parse,extract_clauses,summarize \\"
echo "  --concurrency 3 \\"
echo "  --summarize-level deep \\"
echo "  --retry 5"
echo ""

# ============================================
# Example 7: Resume Interrupted Batch
# ============================================
echo -e "\n${GREEN}Example 7: Resume Interrupted Batch${NC}"
echo "======================================"
echo "Continue from where you left off"
echo ""
echo "Command:"
echo "npm run batch-process -- \\"
echo "  --input ./documents \\"
echo "  --operations parse,summarize \\"
echo "  --resume"
echo ""
echo "Progress saved in: ./batch-results/.batch-progress.json"
echo ""

# ============================================
# Example 8: Multiple Folders Sequential
# ============================================
echo -e "\n${GREEN}Example 8: Multiple Folders Sequential${NC}"
echo "========================================="
echo "Process multiple folders one by one"
echo ""
cat << 'EOF'
# Create a script: process-all.sh
#!/bin/bash

folders=(
  "./contracts"
  "./invoices"
  "./reports"
  "./correspondence"
)

for folder in "${folders[@]}"; do
  echo "Processing $folder..."

  npm run batch-process -- \
    --input "$folder" \
    --operations parse,summarize \
    --concurrency 5 \
    --output "./results/$(basename $folder)"

  echo "✓ $folder completed"
done

echo "✨ All folders processed!"
EOF
echo ""

# ============================================
# Example 9: Cost-Optimized Processing
# ============================================
echo -e "\n${GREEN}Example 9: Cost-Optimized Processing${NC}"
echo "======================================"
echo "Minimize costs (slower but cheaper)"
echo ""
echo "Command:"
echo "npm run batch-process -- \\"
echo "  --input ./documents \\"
echo "  --operations parse,summarize \\"
echo "  --concurrency 2 \\"
echo "  --chunk-size 50 \\"
echo "  --summarize-level quick"
echo ""

# ============================================
# Example 10: Cursor IDE Integration
# ============================================
echo -e "\n${GREEN}Example 10: Cursor IDE Integration${NC}"
echo "====================================="
echo "Run from Cursor with TypeScript"
echo ""
cat << 'EOF'
// cursor-batch.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function main() {
  try {
    const { stdout } = await execAsync(`
      npm run batch-process -- \
        --input ./documents \
        --operations parse,summarize \
        --concurrency 5
    `);

    console.log(stdout);
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
EOF
echo ""

# ============================================
# Comparison Table
# ============================================
echo -e "\n${BLUE}Scenario Comparison${NC}"
echo "===================="
echo ""
printf "%-30s %-15s %-12s %-15s\n" "Scenario" "Files" "Time" "Cost"
echo "--------------------------------------------------------------------------------"
printf "%-30s %-15s %-12s %-15s\n" "4000 images (OCR)" "4000" "2-4h" "~\$6.00"
printf "%-30s %-15s %-12s %-15s\n" "1000 PDFs (parse+summarize)" "1000" "1-2h" "~\$1.80"
printf "%-30s %-15s %-12s %-15s\n" "500 contracts (full analysis)" "500" "45-90m" "~\$1.05"
printf "%-30s %-15s %-12s %-15s\n" "100 docs (quick test)" "100" "<5m" "~\$0.15"
printf "%-30s %-15s %-12s %-15s\n" "50 docs (deep analysis)" "50" "15-30m" "~\$0.25"
echo ""

# ============================================
# Tips
# ============================================
echo -e "\n${YELLOW}💡 Tips for Best Results${NC}"
echo "========================"
echo ""
echo "1. Start small: Test with 10-50 files first"
echo "2. Use --resume: Don't lose progress on interruptions"
echo "3. Monitor costs: Check balance before large batches"
echo "4. Optimize concurrency: Balance speed vs cost"
echo "5. Quick summaries: Use 'quick' level for initial passes"
echo "6. Retry logic: Set --retry 3 for flaky networks"
echo "7. Chunk size: Larger chunks = fewer requests but more memory"
echo "8. Check logs: Backend logs show detailed processing info"
echo ""

echo -e "${BLUE}Ready to process? Choose an example above!${NC}\n"
