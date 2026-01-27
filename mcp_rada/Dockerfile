FROM node:20-alpine AS builder

WORKDIR /app

# Install tzdata for timezone support
RUN apk add --no-cache tzdata

# Set timezone to EET (Europe/Kiev)
ENV TZ=Europe/Kiev
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Copy shared package first (including built dist)
COPY packages/shared/package*.json /app/packages/shared/
COPY packages/shared/dist /app/packages/shared/dist
COPY packages/shared/src /app/packages/shared/src
COPY packages/shared/tsconfig.json /app/packages/shared/tsconfig.json

# Copy package files
COPY mcp_rada/package*.json ./

# Install dependencies
RUN npm install --production=false

# Copy pre-built dist folder (built locally)
COPY mcp_rada/dist ./dist

# Copy migrations SQL files (needed for database setup)
COPY mcp_rada/src/migrations ./src/migrations

# Reinstall only production dependencies
RUN npm install --omit=dev

# Fix the symlink for @secondlayer/shared
RUN rm -rf node_modules/@secondlayer/shared && \
    ln -s /app/packages/shared node_modules/@secondlayer/shared

# Create logs directory
RUN mkdir -p logs

# Set memory limit for Node.js
ENV NODE_OPTIONS="--max-old-space-size=8192"

# Expose HTTP port
EXPOSE 3001

# Start HTTP server by default
CMD ["node", "dist/http-server.js"]
