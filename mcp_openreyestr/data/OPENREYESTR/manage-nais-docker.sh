#!/bin/bash

# NAIS Open Data Docker Management Script
# Manages Docker containers for NAIS Open Data registries

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Functions
show_usage() {
    echo "Usage: $0 {start|stop|restart|status|logs|db-shell|backup|restore|clean}"
    echo ""
    echo "Commands:"
    echo "  start      - Start NAIS Open Data PostgreSQL container"
    echo "  stop       - Stop all containers"
    echo "  restart    - Restart containers"
    echo "  status     - Show container status"
    echo "  logs       - Show container logs"
    echo "  db-shell   - Connect to PostgreSQL shell"
    echo "  backup     - Backup database"
    echo "  restore    - Restore database from backup"
    echo "  clean      - Remove containers and volumes (WARNING: data loss)"
    exit 1
}

check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo -e "${RED}❌ Error: Docker is not running${NC}"
        exit 1
    fi
}

start_containers() {
    echo -e "${GREEN}🚀 Starting NAIS Open Data containers...${NC}"
    docker compose up -d postgres

    echo -e "${YELLOW}⏳ Waiting for PostgreSQL to be ready...${NC}"
    sleep 5

    MAX_RETRIES=30
    RETRY_COUNT=0
    while ! docker exec opendata_postgres pg_isready -U opendatauser -d opendata_db > /dev/null 2>&1; do
        RETRY_COUNT=$((RETRY_COUNT + 1))
        if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
            echo -e "${RED}❌ PostgreSQL did not become ready in time${NC}"
            exit 1
        fi
        echo "  Waiting... ($RETRY_COUNT/$MAX_RETRIES)"
        sleep 2
    done

    echo -e "${GREEN}✅ PostgreSQL is ready!${NC}"
    show_status
}

stop_containers() {
    echo -e "${YELLOW}🛑 Stopping containers...${NC}"
    docker compose stop postgres
    echo -e "${GREEN}✅ Containers stopped${NC}"
}

restart_containers() {
    stop_containers
    start_containers
}

show_status() {
    echo ""
    echo "======================================"
    echo "NAIS Open Data Container Status"
    echo "======================================"
    docker compose ps postgres

    echo ""
    echo "Database Information:"
    docker exec opendata_postgres psql -U opendatauser -d opendata_db -c "
    SELECT
        COUNT(*) FILTER (WHERE tablename NOT IN ('registry_metadata', 'import_log')) as data_tables,
        COUNT(*) as total_tables
    FROM pg_tables
    WHERE schemaname = 'public';" 2>/dev/null || echo "Database not accessible"

    echo ""
    echo "Registry Metadata:"
    docker exec opendata_postgres psql -U opendatauser -d opendata_db -t -c "
    SELECT registry_id || '. ' || registry_name
    FROM registry_metadata
    ORDER BY registry_id;" 2>/dev/null || echo "Registry metadata not available"
}

show_logs() {
    echo -e "${GREEN}📋 Container logs (press Ctrl+C to exit):${NC}"
    docker compose logs -f postgres
}

db_shell() {
    echo -e "${GREEN}🔗 Connecting to PostgreSQL shell...${NC}"
    echo "Database: opendata_db | User: opendatauser"
    docker exec -it opendata_postgres psql -U opendatauser -d opendata_db
}

backup_database() {
    BACKUP_DIR="$SCRIPT_DIR/backups"
    mkdir -p "$BACKUP_DIR"

    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_FILE="$BACKUP_DIR/nais_opendata_${TIMESTAMP}.sql.gz"

    echo -e "${GREEN}💾 Creating backup...${NC}"
    docker exec opendata_postgres pg_dump -U opendatauser -d opendata_db | gzip > "$BACKUP_FILE"

    if [ -f "$BACKUP_FILE" ]; then
        echo -e "${GREEN}✅ Backup created: $BACKUP_FILE${NC}"
        ls -lh "$BACKUP_FILE"
    else
        echo -e "${RED}❌ Backup failed${NC}"
        exit 1
    fi
}

restore_database() {
    echo -e "${YELLOW}📥 Available backups:${NC}"
    BACKUP_DIR="$SCRIPT_DIR/backups"

    if [ ! -d "$BACKUP_DIR" ] || [ -z "$(ls -A $BACKUP_DIR/*.sql.gz 2>/dev/null)" ]; then
        echo -e "${RED}No backups found in $BACKUP_DIR${NC}"
        exit 1
    fi

    ls -lh "$BACKUP_DIR"/*.sql.gz
    echo ""
    read -p "Enter backup file name: " BACKUP_NAME

    BACKUP_FILE="$BACKUP_DIR/$BACKUP_NAME"
    if [ ! -f "$BACKUP_FILE" ]; then
        echo -e "${RED}Backup file not found: $BACKUP_FILE${NC}"
        exit 1
    fi

    echo -e "${YELLOW}⚠️  WARNING: This will overwrite the current database!${NC}"
    read -p "Are you sure? (yes/no): " CONFIRM

    if [ "$CONFIRM" != "yes" ]; then
        echo "Restore cancelled"
        exit 0
    fi

    echo -e "${GREEN}📥 Restoring database...${NC}"
    gunzip -c "$BACKUP_FILE" | docker exec -i opendata_postgres psql -U opendatauser -d opendata_db

    echo -e "${GREEN}✅ Database restored${NC}"
}

clean_all() {
    echo -e "${RED}⚠️  WARNING: This will remove all containers and volumes!${NC}"
    echo -e "${RED}⚠️  ALL DATA WILL BE LOST!${NC}"
    read -p "Are you sure? Type 'DELETE' to confirm: " CONFIRM

    if [ "$CONFIRM" != "DELETE" ]; then
        echo "Clean cancelled"
        exit 0
    fi

    echo -e "${YELLOW}🗑️  Removing containers and volumes...${NC}"
    docker compose down -v
    echo -e "${GREEN}✅ Cleanup complete${NC}"
}

# Main script
check_docker

case "${1:-}" in
    start)
        start_containers
        ;;
    stop)
        stop_containers
        ;;
    restart)
        restart_containers
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    db-shell)
        db_shell
        ;;
    backup)
        backup_database
        ;;
    restore)
        restore_database
        ;;
    clean)
        clean_all
        ;;
    *)
        show_usage
        ;;
esac
