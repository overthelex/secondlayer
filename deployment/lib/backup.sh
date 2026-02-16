#!/bin/bash
##############################################################################
# Backup and rollback functions for deployment
# Creates snapshots before destructive actions, enables rollback on failure
##############################################################################

BACKUP_DIR="/tmp/secondlayer_deploy_backups"

# Create backup before deployment
create_backup() {
    local env=$1
    local target_server=$2
    local repo_root=$3
    local backup_id
    backup_id=$(date +%Y%m%d_%H%M%S)

    local backup_path="${BACKUP_DIR}/${env}/${backup_id}"
    mkdir -p "$backup_path"

    print_msg "$BLUE" "Creating backup $backup_id for $env..."

    # Save git SHA
    local git_sha
    if [ "$target_server" = "localhost" ]; then
        git_sha=$(git -C "$repo_root" rev-parse HEAD 2>/dev/null)
    else
        git_sha=$(ssh -o ConnectTimeout=10 "${DEPLOY_USER}@${target_server}" \
            "git -C /home/${DEPLOY_USER}/SecondLayer rev-parse HEAD" 2>/dev/null)
    fi
    echo "$git_sha" > "${backup_path}/git_sha"
    print_msg "$GREEN" "  Git SHA saved: ${git_sha:0:12}"

    # Tag current Docker images for this environment
    tag_current_images "$env" "$target_server" "$backup_id"

    # Save container state
    save_container_state "$env" "$target_server" "$backup_path"

    # Save backup ID for later rollback
    echo "$backup_id" > "${BACKUP_DIR}/${env}/latest"

    # Cleanup old backups (keep last 3)
    cleanup_old_backups "$env"

    print_msg "$GREEN" "  Backup $backup_id created"
    echo "$backup_id"
}

# Tag running Docker images so we can restore them
tag_current_images() {
    local env=$1
    local target_server=$2
    local backup_id=$3

    local env_short
    case $env in
        stage|staging) env_short="stage" ;;
        dev|development) env_short="dev" ;;
        local) env_short="local" ;;
    esac

    local tag_cmd="docker ps --filter 'name=-${env_short}' --format '{{.Image}}' | sort -u | while read img; do
        # Only tag if not already a backup tag and not a stock image (postgres, redis, etc.)
        if [[ \"\$img\" != *\":backup-\"* ]] && [[ \"\$img\" != postgres:* ]] && [[ \"\$img\" != redis:* ]] && [[ \"\$img\" != nginx:* ]] && [[ \"\$img\" != node:* ]] && [[ \"\$img\" != qdrant/* ]] && [[ \"\$img\" != minio/* ]] && [[ \"\$img\" != prom/* ]] && [[ \"\$img\" != grafana/* ]] && [[ \"\$img\" != oliver006/* ]]; then
            docker tag \"\$img\" \"\${img%%:*}:backup-${backup_id}\" 2>/dev/null || true
        fi
    done"

    if [ "$target_server" = "localhost" ]; then
        eval "$tag_cmd"
    else
        ssh "${DEPLOY_USER}@${target_server}" "$tag_cmd" 2>/dev/null || true
    fi

    print_msg "$GREEN" "  Docker images tagged with backup-${backup_id}"
}

# Save current container state (names, images, status)
save_container_state() {
    local env=$1
    local target_server=$2
    local backup_path=$3

    local env_short
    case $env in
        stage|staging) env_short="stage" ;;
        dev|development) env_short="dev" ;;
        local) env_short="local" ;;
    esac

    local state_cmd="docker ps -a --filter 'name=-${env_short}' --format '{{.Names}}\t{{.Image}}\t{{.Status}}'"

    if [ "$target_server" = "localhost" ]; then
        eval "$state_cmd" > "${backup_path}/containers.txt" 2>/dev/null || true
    else
        ssh "${DEPLOY_USER}@${target_server}" "$state_cmd" > "${backup_path}/containers.txt" 2>/dev/null || true
    fi
}

# Keep only the last N backups per environment
cleanup_old_backups() {
    local env=$1
    local keep=${2:-3}
    local env_dir="${BACKUP_DIR}/${env}"

    if [ ! -d "$env_dir" ]; then
        return
    fi

    # List backup dirs sorted by name (timestamp), skip 'latest' file
    local count=0
    for dir in $(ls -1dr "${env_dir}"/*/ 2>/dev/null); do
        count=$((count + 1))
        if [ $count -gt $keep ]; then
            rm -rf "$dir"
        fi
    done
}

# Rollback to the latest backup
rollback_to_backup() {
    local env=$1
    local target_server=$2
    local compose_file=$3
    local env_file=$4

    local latest_file="${BACKUP_DIR}/${env}/latest"
    if [ ! -f "$latest_file" ]; then
        print_msg "$RED" "No backup found for $env - cannot rollback"
        return 1
    fi

    local backup_id
    backup_id=$(cat "$latest_file")
    local backup_path="${BACKUP_DIR}/${env}/${backup_id}"

    print_msg "$YELLOW" "Rolling back $env to backup $backup_id..."

    # Get the saved git SHA
    local saved_sha=""
    if [ -f "${backup_path}/git_sha" ]; then
        saved_sha=$(cat "${backup_path}/git_sha")
    fi

    local env_short
    case $env in
        stage|staging) env_short="stage" ;;
        dev|development) env_short="dev" ;;
        local) env_short="local" ;;
    esac

    if [ "$target_server" = "localhost" ]; then
        rollback_local "$env" "$compose_file" "$env_file" "$saved_sha" "$backup_id" "$env_short"
    else
        rollback_remote "$env" "$target_server" "$compose_file" "$env_file" "$saved_sha" "$backup_id" "$env_short"
    fi
}

rollback_local() {
    local env=$1
    local compose_file=$2
    local env_file=$3
    local saved_sha=$4
    local backup_id=$5
    local env_short=$6
    local compose_cmd
    compose_cmd=$(get_compose_cmd)
    local compose_args="-f $compose_file"
    if [ -f "$env_file" ]; then
        compose_args="$compose_args --env-file $env_file"
    fi

    # Stop current (possibly broken) containers
    print_msg "$YELLOW" "  Stopping current containers..."
    $compose_cmd $compose_args down 2>/dev/null || true

    # Restore git state
    if [ -n "$saved_sha" ]; then
        print_msg "$YELLOW" "  Restoring git state to ${saved_sha:0:12}..."
        git -C "$(dirname "$SCRIPT_DIR")" reset --hard "$saved_sha" 2>/dev/null || true
    fi

    # Restart with old state
    print_msg "$YELLOW" "  Starting containers from previous state..."
    $compose_cmd $compose_args up -d 2>/dev/null || true

    print_msg "$GREEN" "  Rollback complete for $env"
}

rollback_remote() {
    local env=$1
    local target_server=$2
    local compose_file=$3
    local env_file=$4
    local saved_sha=$5
    local backup_id=$6
    local env_short=$7

    local remote_repo="/home/${DEPLOY_USER}/SecondLayer"

    ssh "${DEPLOY_USER}@${target_server}" "export SAVED_SHA='$saved_sha' COMPOSE_FILE='$compose_file' ENV_FILE='$env_file' REMOTE_REPO='$remote_repo'; bash -s" << 'ROLLBACK_EOF'
        cd "$REMOTE_REPO/deployment"

        # Stop current containers
        echo "  Stopping current containers..."
        docker compose -f $COMPOSE_FILE --env-file $ENV_FILE down 2>/dev/null || true

        # Restore git state
        if [ -n "$SAVED_SHA" ]; then
            echo "  Restoring git to $SAVED_SHA..."
            git -C "$REMOTE_REPO" reset --hard "$SAVED_SHA" 2>/dev/null || true
        fi

        # Rebuild and restart
        echo "  Rebuilding from previous state..."
        docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d --build 2>/dev/null || true

        echo "  Rollback complete"
ROLLBACK_EOF

    print_msg "$GREEN" "  Remote rollback complete for $env"
}
