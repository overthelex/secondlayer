#!/bin/bash
# Script to update components to use useBackNavigation hook

COMPONENTS=(
  "LegislationMonitoringPage"
  "CourtPracticeAnalysisPage"
  "LegalInitiativesPage"
  "LegislationStatisticsPage"
  "VotingAnalysisPage"
  "LegalCodesLibraryPage"
  "HistoricalAnalysisPage"
)

for comp in "${COMPONENTS[@]}"; do
  FILE="src/components/${comp}.tsx"

  if [ ! -f "$FILE" ]; then
    echo "File not found: $FILE"
    continue
  fi

  echo "Updating $FILE..."

  # Check if already updated
  if grep -q "useBackNavigation" "$FILE"; then
    echo "  -> Already updated, skipping"
    continue
  fi

  # Add import after other React imports
  if ! grep -q "import { useBackNavigation }" "$FILE"; then
    # Find the last import line
    last_import_line=$(grep -n "^import" "$FILE" | tail -1 | cut -d: -f1)

    # Insert import after last import
    sed -i "${last_import_line}a\\import { useBackNavigation } from '../hooks/useBackNavigation';" "$FILE"
  fi

  # Find the line with export function and onBack parameter
  export_line=$(grep -n "export function ${comp}.*onBack" "$FILE" | cut -d: -f1)

  if [ -n "$export_line" ]; then
    # Find the opening brace of the function
    next_line=$((export_line + 1))

    # Insert handleBack hook after function opening
    sed -i "${next_line}i\\  const handleBack = useBackNavigation(onBack);" "$FILE"

    # Replace onClick={onBack} with onClick={handleBack}
    sed -i 's/onClick={onBack}/onClick={handleBack}/g' "$FILE"

    echo "  -> Updated successfully"
  else
    echo "  -> No onBack parameter found"
  fi
done

echo "Done!"
