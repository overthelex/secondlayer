#!/bin/bash
# Batch git housekeeping - runs Claude in headless mode
# Creates a feature branch, commits changes, pushes, and opens a PR (main is protected)
cd "$(dirname "$0")/../.." || exit 1

claude -p "Check for uncommitted changes. If there are changes: 1) Create a descriptive feature branch, 2) Stage and commit with a descriptive message, 3) Push the branch, 4) Create a PR via 'gh pr create'. NEVER push directly to main." --allowedTools "Bash,Read,Glob"
