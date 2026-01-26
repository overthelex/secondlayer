FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules (canvas, playwright)
RUN apk add --no-cache \
    build-base \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    python3

# Install dependencies
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

# Start SSE-based MCP server for remote access (production)
# Use SSE server for remote MCP clients, HTTP server for REST API
CMD ["node", "--max-old-space-size=8192", "dist/sse-server.js"]
