# Multi-stage build for SecondLayer Developer Platform
# Stage 1: Build the React application
FROM node:20-alpine AS builder

WORKDIR /app/platform

# Copy package files (lock file required for deterministic builds)
COPY platform/package.json platform/package-lock.json ./

# Install dependencies deterministically from lock file
RUN npm ci

# Accept build arguments
ARG BUILD_ENV=production
ARG VITE_API_URL=https://platform.legal.org.ua
ARG VITE_TURNSTILE_SITE_KEY=
ARG GIT_SHA=unknown

# Copy source code
COPY platform/ ./

# Set env vars for build
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY

# Build the application
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Copy built assets from builder stage
COPY --from=builder /app/platform/dist /usr/share/nginx/html

# Copy custom nginx configuration
COPY platform/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
