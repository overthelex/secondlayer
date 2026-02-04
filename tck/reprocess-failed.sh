#!/bin/bash

# Reprocess failed PDF files with reduced DPI (150)

API_URL="http://localhost:3002/api/parse-document"
OUTPUT_DIR="./parsed-results"

echo "🔄 Reprocessing Failed Files (150 DPI)"
echo "======================================="
echo ""

# Array of failed files
failed_files=(
    "Додаток 1 - Наказ про звільнення Кириченко ІВ .pdf"
    "Додаток 5 - Копія Довідки №1-71 від 30.09.2021 .pdf"
    "Додаток 6 - Копія звернення від 19.06.2025 до Оболонського ТЦК та СП.pdf"
    "Додаток 7 - Копія звернення від 18.09.2025 до Київського міського ТЦК та СП.pdf"
)

success=0
failed=0
total=${#failed_files[@]}

for i in "${!failed_files[@]}"; do
    file="${failed_files[$i]}"
    num=$((i + 1))

    echo "📄 Processing [$num/$total]: $file"

    if [ ! -f "$file" ]; then
        echo "  ⚠️  File not found, skipping"
        failed=$((failed + 1))
        echo ""
        continue
    fi

    start_time=$(date +%s)

    # Get file size
    file_size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
    file_size_kb=$((file_size / 1024))

    echo "  Size: ${file_size_kb} KB"
    echo "  Creating JSON payload..."

    # Create JSON payload in temp file
    temp_payload="/tmp/reprocess_${num}_$$.json"

    {
        printf '{"fileBase64":"'
        base64 -w 0 "$file" 2>/dev/null || base64 "$file" 2>/dev/null
        printf '","mimeType":"application/pdf","filename":"%s"}' "$file"
    } > "$temp_payload"

    if [ ! -s "$temp_payload" ]; then
        echo "  ❌ Error: Failed to create JSON payload"
        rm -f "$temp_payload"
        failed=$((failed + 1))
        echo ""
        continue
    fi

    echo "  Sending to document service..."

    # Send to API with longer timeout for large files
    response=$(curl -s -X POST "$API_URL" \
        -H "Content-Type: application/json" \
        --data-binary @"$temp_payload" \
        --max-time 600 2>&1)

    rm -f "$temp_payload"

    end_time=$(date +%s)
    processing_time=$((end_time - start_time))

    # Check response
    if echo "$response" | jq -e '.error' > /dev/null 2>&1; then
        error_msg=$(echo "$response" | jq -r '.error')
        echo "  ❌ Error: $error_msg"
        failed=$((failed + 1))
    elif echo "$response" | jq -e '.text' > /dev/null 2>&1; then
        text=$(echo "$response" | jq -r '.text')
        text_length=${#text}
        source=$(echo "$response" | jq -r '.metadata.source // "unknown"')
        page_count=$(echo "$response" | jq -r '.metadata.pageCount // "N/A"')

        echo "  ✅ Success! Extracted $text_length characters"
        echo "  Processing time: ${processing_time}s"
        echo "  Source: $source"
        echo "  Pages: $page_count"

        # Save to file
        filename_no_ext="${file%.*}"
        output_file="$OUTPUT_DIR/${filename_no_ext}.txt"
        echo "$text" > "$output_file"
        echo "  💾 Saved to: $output_file"

        # Save JSON
        output_json="$OUTPUT_DIR/${filename_no_ext}.json"
        echo "$response" | jq '.' > "$output_json"

        success=$((success + 1))
    else
        echo "  ❌ Error: Invalid response"
        failed=$((failed + 1))
    fi

    echo ""
done

echo ""
echo "📊 Reprocessing Summary"
echo "======================="
echo ""
echo "Total files: $total"
echo "✅ Successful: $success"
echo "❌ Failed: $failed"
echo ""

if [ $failed -gt 0 ]; then
    exit 1
else
    echo "🎉 All files reprocessed successfully!"
    exit 0
fi
