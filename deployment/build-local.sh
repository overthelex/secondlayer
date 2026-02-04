#!/bin/bash

##############################################################################
# Local Build and Test Script
# Optimized for multi-core systems (16 CPU)
# Uses Docker BuildKit for parallel builds and better caching
##############################################################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Enable BuildKit for better performance
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

# Use all available CPUs
export DOCKER_BUILD_PARALLELISM=16

print_msg() {
    local color=$1
    shift
    echo -e "${color}$@${NC}"
}

print_header() {
    echo ""
    print_msg "$BLUE" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    print_msg "$BLUE" "  $1"
    print_msg "$BLUE" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# Check Docker
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_msg "$RED" "❌ Docker not installed"
        exit 1
    fi

    if ! docker info > /dev/null 2>&1; then
        print_msg "$RED" "❌ Docker daemon not running"
        exit 1
    fi

    print_msg "$GREEN" "✅ Docker is running"
}

# Show system info
show_system_info() {
    print_header "System Information"

    print_msg "$YELLOW" "CPU Cores:"
    nproc

    print_msg "$YELLOW" "Memory:"
    free -h | grep "Mem:" | awk '{print "  Total: " $2 ", Available: " $7}'

    print_msg "$YELLOW" "Disk Space:"
    df -h / | tail -1 | awk '{print "  Available: " $4 " / " $2}'

    print_msg "$YELLOW" "Docker Version:"
    docker version --format '  {{.Server.Version}}'

    print_msg "$YELLOW" "BuildKit Enabled:"
    echo "  ${DOCKER_BUILDKIT}"
}

# Clean old images
clean_old_images() {
    print_header "Cleaning Old Images"

    # Remove old versions but keep latest
    docker images | grep secondlayer-app | grep -v latest | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true
    docker images | grep lexwebapp-lexwebapp | grep -v latest | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true

    # Prune dangling images
    docker image prune -f

    print_msg "$GREEN" "✅ Cleanup complete"
}

# Build backend with BuildKit
build_backend() {
    print_header "Building Backend (mcp_backend)"

    cd "$ROOT_DIR"

    print_msg "$YELLOW" "Context: $PWD"
    print_msg "$YELLOW" "Dockerfile: mcp_backend/Dockerfile"
    print_msg "$YELLOW" "Using BuildKit with parallel builds..."

    local start_time=$(date +%s)

    # Build with BuildKit and caching
    DOCKER_BUILDKIT=1 docker build \
        --progress=plain \
        --build-arg BUILDKIT_INLINE_CACHE=1 \
        -f mcp_backend/Dockerfile \
        -t secondlayer-app:latest \
        -t secondlayer-app:$(date +%Y%m%d-%H%M%S) \
        .

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    print_msg "$GREEN" "✅ Backend built in ${duration}s"
}

# Build frontend with BuildKit
build_frontend() {
    print_header "Building Frontend (lexwebapp)"

    cd "$ROOT_DIR/lexwebapp"

    print_msg "$YELLOW" "Context: $PWD"
    print_msg "$YELLOW" "Using multi-stage build with BuildKit..."

    local start_time=$(date +%s)

    # Build with BuildKit and caching
    DOCKER_BUILDKIT=1 docker build \
        --progress=plain \
        --build-arg BUILDKIT_INLINE_CACHE=1 \
        --build-arg NODE_ENV=production \
        -t lexwebapp-lexwebapp:latest \
        -t lexwebapp-lexwebapp:$(date +%Y%m%d-%H%M%S) \
        .

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    print_msg "$GREEN" "✅ Frontend built in ${duration}s"
}

# Build both in parallel
build_parallel() {
    print_header "Building Images in Parallel"

    print_msg "$YELLOW" "Starting parallel builds..."

    local start_time=$(date +%s)

    # Build backend in background
    (build_backend) &
    local backend_pid=$!

    # Build frontend in background
    (build_frontend) &
    local frontend_pid=$!

    # Wait for both
    print_msg "$YELLOW" "Waiting for backend build (PID: $backend_pid)..."
    wait $backend_pid
    local backend_status=$?

    print_msg "$YELLOW" "Waiting for frontend build (PID: $frontend_pid)..."
    wait $frontend_pid
    local frontend_status=$?

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    if [ $backend_status -ne 0 ] || [ $frontend_status -ne 0 ]; then
        print_msg "$RED" "❌ Build failed!"
        exit 1
    fi

    print_msg "$GREEN" "✅ All images built successfully in ${duration}s"
}

# Show built images
show_images() {
    print_header "Built Images"

    docker images | grep -E "REPOSITORY|secondlayer-app|lexwebapp-lexwebapp" | head -10
}

# Test local deployment
test_local() {
    print_header "Testing Local Deployment"

    cd "$SCRIPT_DIR"

    # Stop any running local environment
    print_msg "$YELLOW" "Stopping existing local environment..."
    docker compose -f docker-compose.local.yml down 2>/dev/null || true

    # Start local environment
    print_msg "$YELLOW" "Starting local environment..."
    if [ -f ".env.local" ]; then
        docker compose -f docker-compose.local.yml --env-file .env.local up -d
    else
        docker compose -f docker-compose.local.yml up -d
    fi

    # Wait for services
    print_msg "$YELLOW" "Waiting for services to start..."
    sleep 10

    # Check health
    print_msg "$YELLOW" "Checking service health..."

    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
            print_msg "$GREEN" "✅ Backend is healthy"
            break
        fi

        attempt=$((attempt + 1))
        echo -n "."
        sleep 2
    done

    if [ $attempt -eq $max_attempts ]; then
        print_msg "$RED" "❌ Backend health check failed"
        print_msg "$YELLOW" "Showing logs:"
        docker compose -f docker-compose.local.yml logs --tail=50
        return 1
    fi

    # Show running containers
    print_msg "$YELLOW" "Running containers:"
    docker ps --filter "name=secondlayer-.*-local"

    print_msg "$GREEN" "✅ Local deployment is running"
    print_msg "$BLUE" "Access backend at: http://localhost:3000"
    print_msg "$BLUE" "Access frontend at: http://localhost:3000"
}

# Show logs
show_logs() {
    print_header "Container Logs"

    cd "$SCRIPT_DIR"
    docker compose -f docker-compose.local.yml logs --tail=100
}

# Main menu
show_menu() {
    cat << EOF

Local Build & Test Menu:
  1) Build all (parallel)
  2) Build backend only
  3) Build frontend only
  4) Test local deployment
  5) Show built images
  6) Show logs
  7) Clean old images
  8) Full pipeline (clean + build + test)
  9) Stop local environment
  0) Exit

EOF
}

# Stop local environment
stop_local() {
    print_header "Stopping Local Environment"

    cd "$SCRIPT_DIR"
    docker compose -f docker-compose.local.yml down

    print_msg "$GREEN" "✅ Local environment stopped"
}

# Full pipeline
full_pipeline() {
    local start_time=$(date +%s)

    show_system_info
    clean_old_images
    build_parallel
    show_images
    test_local

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    print_header "Pipeline Complete"
    print_msg "$GREEN" "✅ Total time: ${duration}s"
}

# Main script
main() {
    check_docker

    # If arguments provided, execute command
    if [ $# -gt 0 ]; then
        case $1 in
            build|build-all)
                show_system_info
                build_parallel
                show_images
                ;;
            build-backend)
                build_backend
                ;;
            build-frontend)
                build_frontend
                ;;
            test)
                test_local
                ;;
            logs)
                show_logs
                ;;
            clean)
                clean_old_images
                ;;
            stop)
                stop_local
                ;;
            full|pipeline)
                full_pipeline
                ;;
            info)
                show_system_info
                ;;
            images)
                show_images
                ;;
            *)
                echo "Usage: $0 {build|build-backend|build-frontend|test|logs|clean|stop|full|info|images}"
                exit 1
                ;;
        esac
        exit 0
    fi

    # Interactive mode
    while true; do
        show_menu
        read -p "Select option: " choice

        case $choice in
            1) build_parallel ;;
            2) build_backend ;;
            3) build_frontend ;;
            4) test_local ;;
            5) show_images ;;
            6) show_logs ;;
            7) clean_old_images ;;
            8) full_pipeline ;;
            9) stop_local ;;
            0)
                print_msg "$GREEN" "Goodbye!"
                exit 0
                ;;
            *)
                print_msg "$RED" "Invalid option"
                ;;
        esac

        echo ""
        read -p "Press Enter to continue..."
    done
}

main "$@"
