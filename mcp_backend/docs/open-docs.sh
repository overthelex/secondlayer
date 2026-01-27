#!/bin/bash

# Quick documentation opener for SecondLayer MCP API
# Usage: ./open-docs.sh [api|index]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default to index if no argument provided
DOC_TYPE="${1:-index}"

case "$DOC_TYPE" in
    api|explorer|api-explorer)
        DOC_FILE="$SCRIPT_DIR/api-explorer.html"
        echo "🔧 Opening API Explorer..."
        ;;
    index|hub|home)
        DOC_FILE="$SCRIPT_DIR/index.html"
        echo "📚 Opening Documentation Hub..."
        ;;
    quick|quickstart)
        DOC_FILE="$SCRIPT_DIR/QUICKSTART.md"
        echo "🚀 Opening Quick Start Guide..."
        ;;
    readme)
        DOC_FILE="$SCRIPT_DIR/README.md"
        echo "📖 Opening README..."
        ;;
    *)
        echo "❌ Unknown documentation type: $DOC_TYPE"
        echo ""
        echo "Usage: $0 [api|index|quick|readme]"
        echo ""
        echo "Options:"
        echo "  api, explorer    - Open API Explorer (Swagger-style)"
        echo "  index, hub       - Open Documentation Hub (default)"
        echo "  quick, quickstart - Open Quick Start Guide"
        echo "  readme           - Open README"
        exit 1
        ;;
esac

# Check if file exists
if [ ! -f "$DOC_FILE" ]; then
    echo "❌ Error: File not found: $DOC_FILE"
    exit 1
fi

# Open in browser (works on Linux and macOS)
if command -v xdg-open > /dev/null; then
    xdg-open "$DOC_FILE"
elif command -v open > /dev/null; then
    open "$DOC_FILE"
elif command -v start > /dev/null; then
    start "$DOC_FILE"
else
    echo "❌ Could not detect browser opener command"
    echo "📄 Please open manually: $DOC_FILE"
    exit 1
fi

echo "✅ Documentation opened successfully!"
echo "📄 File: $(basename "$DOC_FILE")"
