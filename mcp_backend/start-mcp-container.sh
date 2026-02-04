#!/bin/bash
# MCP Server wrapper for Jan Chat using Docker container

CONTAINER_ID="7fab0fdcc146284d935b99d47b4ee48686c47aba1a22e4a0d85cdbc618238cff"
CONTAINER_NAME="secondlayer-app-local"

# Check if container is running
if ! docker ps --no-trunc | grep -q "$CONTAINER_ID"; then
    echo "Error: Container $CONTAINER_NAME is not running" >&2
    exit 1
fi

# Execute MCP server in STDIO mode inside the container
exec docker exec -i "$CONTAINER_ID" node dist/index.js
