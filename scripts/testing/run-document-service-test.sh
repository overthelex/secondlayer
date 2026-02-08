#!/bin/bash
# Quick test runner for document-service-local

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=================================="
echo "Document Service Test Runner"
echo "=================================="

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if service is running
check_service() {
    echo -e "\n${YELLOW}Checking if document-service is running...${NC}"

    if curl -s http://localhost:3002/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Service is running${NC}"
        return 0
    else
        echo -e "${RED}✗ Service is not running${NC}"
        return 1
    fi
}

# Start service
start_service() {
    echo -e "\n${YELLOW}Starting document-service-local with Docker Compose...${NC}"
    cd deployment

    # Check if already running
    if docker ps | grep -q "document-service-local"; then
        echo -e "${GREEN}✓ Service is already running${NC}"
    else
        echo "Building and starting service..."
        docker-compose -f docker-compose.local.yml up -d \
            postgres-local \
            qdrant-local \
            redis-local \
            document-service-local

        echo -e "${YELLOW}Waiting for service to be ready (max 60 seconds)...${NC}"
        for i in {1..60}; do
            if curl -s http://localhost:3002/health > /dev/null 2>&1; then
                echo -e "${GREEN}✓ Service is ready after ${i} seconds${NC}"
                break
            fi
            echo -n "."
            sleep 1
        done
    fi

    cd "$SCRIPT_DIR"
}

# Run tests
run_tests() {
    echo -e "\n${YELLOW}Running integration tests...${NC}"

    # Check if ts-node is available
    if ! command -v ts-node &> /dev/null; then
        echo -e "${YELLOW}ts-node not found, installing temporarily...${NC}"
        npx ts-node test-document-service.ts
    else
        ts-node test-document-service.ts
    fi
}

# View logs
view_logs() {
    echo -e "\n${YELLOW}Showing document-service logs (last 50 lines)...${NC}"
    docker logs --tail 50 document-service-local
}

# Stop service
stop_service() {
    echo -e "\n${YELLOW}Stopping document-service-local...${NC}"
    cd deployment
    docker-compose -f docker-compose.local.yml stop document-service-local
    cd "$SCRIPT_DIR"
    echo -e "${GREEN}✓ Service stopped${NC}"
}

# Main menu
case "${1:-test}" in
    test)
        if ! check_service; then
            start_service
        fi
        run_tests
        ;;

    start)
        start_service
        ;;

    stop)
        stop_service
        ;;

    restart)
        stop_service
        start_service
        ;;

    logs)
        view_logs
        ;;

    status)
        check_service
        docker ps | grep "document-service-local" || echo "Service not running"
        ;;

    clean)
        echo -e "${YELLOW}Stopping and removing containers...${NC}"
        cd deployment
        docker-compose -f docker-compose.local.yml down
        cd "$SCRIPT_DIR"
        echo -e "${GREEN}✓ Cleanup complete${NC}"
        ;;

    *)
        echo "Usage: $0 {test|start|stop|restart|logs|status|clean}"
        echo ""
        echo "Commands:"
        echo "  test     - Start service and run tests (default)"
        echo "  start    - Start document-service-local"
        echo "  stop     - Stop document-service-local"
        echo "  restart  - Restart document-service-local"
        echo "  logs     - View service logs"
        echo "  status   - Check service status"
        echo "  clean    - Stop and remove all containers"
        exit 1
        ;;
esac

echo -e "\n${GREEN}Done!${NC}"
