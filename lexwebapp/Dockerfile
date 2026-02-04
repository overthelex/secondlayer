# Multi-stage build for Lexwebapp frontend
# Stage 1: Build the React application
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY lexwebapp/package*.json ./

# Copy shared package for dependencies
COPY packages/shared ./packages/shared

# Install shared package dependencies first
WORKDIR /app/packages/shared
RUN npm install

# Back to app directory and install app dependencies
WORKDIR /app
RUN npm install

# Accept build arguments BEFORE copying source
ARG BUILD_ENV=production
ARG VITE_API_URL

# Copy source code (excluding already copied files)
COPY lexwebapp/ .

# Create .env file with VITE_API_URL for Vite build
RUN echo "VITE_API_URL=${VITE_API_URL:-http://localhost:3000/api}" > .env.production && \
    echo "Created .env.production with VITE_API_URL=${VITE_API_URL:-http://localhost:3000/api}"

# Build the application
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
