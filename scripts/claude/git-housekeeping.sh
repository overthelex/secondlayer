#!/bin/bash
# Batch git housekeeping - runs Claude in headless mode
cd "$(dirname "$0")/../.." || exit 1

claude -p "Check for uncommitted changes, stage everything, create a descriptive commit message, and push to origin main" --allowedTools "Bash,Read,Glob"
