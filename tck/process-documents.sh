#!/bin/bash

# Document Processing Script for Docker Container
# Sends all PDF, DOCX, and HTML files to document-service API

API_URL="http://localhost:3002/api/parse-document"
OUTPUT_DIR="./parsed-results"

echo "🚀 Document Processing Script"
echo "============================="
echo ""
echo "API URL: $API_URL"
echo "Output directory: $OUTPUT_DIR"
echo ""

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Counter variables
total=0
success=0
failed=0
start_total_time=$(date +%s)

# Find all document files
shopt -s nullglob
files=(*.pdf *.PDF *.docx *.DOCX *.doc *.DOC *.html *.HTML *.htm *.HTM)

if [ ${#files[@]} -eq 0 ]; then
    echo "No documents found to process."
    exit 0
fi

echo "Found ${#files[@]} document(s) to process"
echo ""

# Function to detect MIME type
detect_mime_type() {
    local filename="$1"
    local ext="${filename##*.}"
    ext=$(echo "$ext" | tr '[:upper:]' '[:lower:]')

    case "$ext" in
        pdf)
            echo "application/pdf"
            ;;
        docx)
            echo "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ;;
        doc)
            echo "application/msword"
            ;;
        html|htm)
            echo "text/html"
            ;;
        *)
            echo ""
            ;;
    esac
}

# Process each file
for file in "${files[@]}"; do
    total=$((total + 1))
    echo "📄 Processing [$total/${#files[@]}]: $file"

    start_time=$(date +%s)

    # Detect MIME type
    mime_type=$(detect_mime_type "$file")

    if [ -z "$mime_type" ]; then
        echo "  ⏭️  Skipping unsupported file type"
        failed=$((failed + 1))
        echo ""
        continue
    fi

    # Get file size
    file_size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
    file_size_kb=$((file_size / 1024))

    echo "  Size: ${file_size_kb} KB"
    echo "  Type: $mime_type"
    echo "  Encoding to base64..."

    # Encode file to base64 and create JSON payload in a temp file
    temp_payload="/tmp/payload_${total}_$$.json"

    # Create JSON payload using printf to avoid argument list limits
    {
        printf '{"fileBase64":"'
        base64 -w 0 "$file" 2>/dev/null || base64 "$file" 2>/dev/null
        printf '","mimeType":"%s","filename":"%s"}' "$mime_type" "$file"
    } > "$temp_payload"

    # Verify JSON was created
    if [ ! -s "$temp_payload" ]; then
        echo "  ❌ Error: Failed to create JSON payload"
        rm -f "$temp_payload"
        failed=$((failed + 1))
        echo ""
        continue
    fi

    echo "  Sending to document service..."

    # Send to API
    response=$(curl -s -X POST "$API_URL" \
        -H "Content-Type: application/json" \
        --data-binary @"$temp_payload" \
        --max-time 300 2>&1)

    # Clean up temp file
    rm -f "$temp_payload"

    end_time=$(date +%s)
    processing_time=$((end_time - start_time))

    # Check if response contains error
    if echo "$response" | jq -e '.error' > /dev/null 2>&1; then
        error_msg=$(echo "$response" | jq -r '.error')
        echo "  ❌ Error: $error_msg"
        failed=$((failed + 1))
    elif echo "$response" | jq -e '.text' > /dev/null 2>&1; then
        # Extract text and metadata
        text=$(echo "$response" | jq -r '.text')
        text_length=${#text}
        source=$(echo "$response" | jq -r '.metadata.source // "unknown"')
        page_count=$(echo "$response" | jq -r '.metadata.pageCount // "N/A"')

        echo "  ✅ Success! Extracted $text_length characters"
        echo "  Processing time: ${processing_time}s"
        echo "  Source: $source"
        echo "  Pages: $page_count"

        # Save parsed text to file
        filename_no_ext="${file%.*}"
        output_file="$OUTPUT_DIR/${filename_no_ext}.txt"
        echo "$text" > "$output_file"
        echo "  💾 Saved to: $output_file"

        # Save full response as JSON
        output_json="$OUTPUT_DIR/${filename_no_ext}.json"
        echo "$response" | jq '.' > "$output_json"

        success=$((success + 1))
    else
        echo "  ❌ Error: Invalid API response"
        echo "  Response: $response"
        failed=$((failed + 1))
    fi

    echo ""
done

end_total_time=$(date +%s)
total_time=$((end_total_time - start_total_time))

# Print summary
echo ""
echo "📊 Processing Summary"
echo "====================="
echo ""
echo "Total documents: $total"
echo "✅ Successful: $success"
echo "❌ Failed: $failed"
echo "⏱️  Total time: ${total_time}s"
echo "📁 Results saved to: $OUTPUT_DIR/"
echo ""

if [ $failed -gt 0 ]; then
    echo "⚠️  Some documents failed to process. Check the output above for details."
    exit 1
else
    echo "🎉 All documents processed successfully!"
    exit 0
fi
