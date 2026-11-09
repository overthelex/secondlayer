# Multi-stage build for Lexwebapp frontend
# Stage 1: Build the React application
FROM node:20-alpine AS builder

WORKDIR /app/lexwebapp

# Copy only lexwebapp package files (standalone install, no monorepo workspace)
COPY lexwebapp/package.json lexwebapp/package-lock.json* ./

# Install dependencies directly in lexwebapp
RUN npm install --legacy-peer-deps

# Accept build arguments
ARG BUILD_ENV=staging
ARG VITE_API_URL=https://stage.legal.org.ua/api
ARG VITE_API_KEY
ARG VITE_ENABLE_SSE_STREAMING=true
ARG VITE_ENABLE_ALL_MCP_TOOLS=true
ARG VITE_SHOW_TOOL_SELECTOR=true
ARG VITE_ENABLE_THINKING_STEPS=true
ARG VITE_AUTO_EXPAND_THINKING=true
ARG VITE_TURNSTILE_SITE_KEY=
# GIT_SHA busts the cache on every new deploy so stale layers are never reused
ARG GIT_SHA=unknown
ARG APP_VERSION=dev
ARG APP_FRONTEND_VERSION=dev

# Copy lexwebapp source code
COPY lexwebapp/ ./
# Copy VERSION file if exists (for fallback)
COPY VERSION* ./

# Set env vars for build
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_API_KEY=$VITE_API_KEY
ENV VITE_ENABLE_SSE_STREAMING=$VITE_ENABLE_SSE_STREAMING
ENV VITE_ENABLE_ALL_MCP_TOOLS=$VITE_ENABLE_ALL_MCP_TOOLS
ENV VITE_SHOW_TOOL_SELECTOR=$VITE_SHOW_TOOL_SELECTOR
ENV VITE_ENABLE_THINKING_STEPS=$VITE_ENABLE_THINKING_STEPS
ENV VITE_AUTO_EXPAND_THINKING=$VITE_AUTO_EXPAND_THINKING
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY
ENV APP_VERSION=$APP_VERSION
ENV APP_FRONTEND_VERSION=$APP_FRONTEND_VERSION

# Build the application using the correct mode and normalize output to /app/lexwebapp/dist
RUN if [ "$BUILD_ENV" = "production" ]; then \
      npm run build; \
    else \
      npm run build:staging && mv dist-staging dist; \
    fi

# Stage 2: Serve with nginx
FROM nginx:alpine

# Copy built assets from builder stage
COPY --from=builder /app/lexwebapp/dist /usr/share/nginx/html

# Add .mjs MIME type (ES modules — required for pdf.js worker)
RUN sed -i 's|application/javascript\s*js;|application/javascript js mjs;|' /etc/nginx/mime.types

# Copy custom nginx configuration
COPY lexwebapp/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
