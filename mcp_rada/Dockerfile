FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies for smaller runtime image
RUN npm prune --omit=dev

# Create logs directory
RUN mkdir -p logs

# Set memory limit for Node.js
ENV NODE_OPTIONS="--max-old-space-size=8192"

# Expose HTTP port
EXPOSE 3001

# Start HTTP server by default
CMD ["node", "dist/http-server.js"]
