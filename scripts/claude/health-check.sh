#!/bin/bash
# Pre-deploy health check - runs Claude in headless mode
cd "$(dirname "$0")/../.." || exit 1

claude -p "Check all services are running on this machine. List any containers that are stopped or unhealthy. Check disk space and memory. Report any issues." --allowedTools "Bash,Read"
