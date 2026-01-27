FROM node:20-alpine

WORKDIR /app

# Install dependencies for Playwright (browser automation)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tzdata

# Set timezone to EET (Europe/Kiev)
ENV TZ=Europe/Kiev
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Tell Playwright to use installed chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy root package.json files
COPY package*.json ./

# Copy shared package
COPY packages/shared ./packages/shared

# Copy backend package
COPY mcp_backend ./mcp_backend

# Install shared package dependencies and build
WORKDIR /app/packages/shared
RUN npm install && npm run build

# Install backend dependencies and build
WORKDIR /app/mcp_backend
RUN npm install && npm run build

# Expose port
EXPOSE 3000

# Set working directory to backend
WORKDIR /app/mcp_backend

# Start SSE-based MCP server for remote access (production)
# Use SSE server for remote MCP clients, HTTP server for REST API
CMD ["node", "--max-old-space-size=8192", "dist/sse-server.js"]
