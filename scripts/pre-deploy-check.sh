#!/bin/bash
claude -p "Check the local dev environment health: 1) Verify all TypeScript packages build without errors, 2) Check docker compose config is valid, 3) Verify .env.dev has all required variables matching .env.example, 4) Check no port conflicts on 3000,5173,9000,8080. Report any issues found." \
  --allowedTools "Bash,Read,Grep" \
  --output-format text
