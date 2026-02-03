# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install tzdata for timezone support
RUN apk add --no-cache tzdata

# Set timezone to EET (Europe/Kiev)
ENV TZ=Europe/Kiev
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code and migrations
COPY src ./src

# Build TypeScript
RUN npm run build

# Copy SQL migration files to dist
RUN mkdir -p dist/migrations && \
    cp src/migrations/*.sql dist/migrations/

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install tzdata for timezone support
RUN apk add --no-cache tzdata

# Set timezone to EET (Europe/Kiev)
ENV TZ=Europe/Kiev
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --production

# Copy built application
COPY --from=builder /app/dist ./dist

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose HTTP port
EXPOSE 3004

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3004/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Default to HTTP server mode
CMD ["node", "dist/http-server.js"]
