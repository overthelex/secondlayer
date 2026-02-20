# Multi-stage build for Lexwebapp frontend
# Stage 1: Build the React application
FROM node:20-alpine AS builder

WORKDIR /app/lexwebapp

# Copy only lexwebapp package files (standalone install, no monorepo workspace)
COPY lexwebapp/package.json lexwebapp/package-lock.json* ./

# Install dependencies directly in lexwebapp
RUN npm install --legacy-peer-deps

# Cache-bust: copy git HEAD ref so Docker invalidates cache on every new commit
COPY .git/HEAD .git/HEAD

# Accept build arguments
ARG BUILD_ENV=staging
ARG VITE_API_URL=https://stage.legal.org.ua/api
ARG VITE_API_KEY
ARG VITE_ENABLE_SSE_STREAMING=true
ARG VITE_ENABLE_ALL_MCP_TOOLS=true
ARG VITE_SHOW_TOOL_SELECTOR=true
ARG VITE_ENABLE_THINKING_STEPS=true
ARG VITE_AUTO_EXPAND_THINKING=true

# Copy lexwebapp source code
COPY lexwebapp/ ./

# Set env vars for build
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_API_KEY=$VITE_API_KEY
ENV VITE_ENABLE_SSE_STREAMING=$VITE_ENABLE_SSE_STREAMING
ENV VITE_ENABLE_ALL_MCP_TOOLS=$VITE_ENABLE_ALL_MCP_TOOLS
ENV VITE_SHOW_TOOL_SELECTOR=$VITE_SHOW_TOOL_SELECTOR
ENV VITE_ENABLE_THINKING_STEPS=$VITE_ENABLE_THINKING_STEPS
ENV VITE_AUTO_EXPAND_THINKING=$VITE_AUTO_EXPAND_THINKING

# Build the application for staging
RUN npm run build:staging

# Stage 2: Serve with nginx
FROM nginx:alpine

# Copy built assets from builder stage (staging build outputs to dist-staging)
COPY --from=builder /app/lexwebapp/dist-staging /usr/share/nginx/html

# Copy custom nginx configuration
COPY lexwebapp/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
