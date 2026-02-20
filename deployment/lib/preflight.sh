#!/bin/bash
##############################################################################
# Pre-flight checks for deployment
# Validates environment before any destructive actions
##############################################################################

# Minimum free disk space in GB
MIN_DISK_SPACE_GB=${MIN_DISK_SPACE_GB:-5}

# Track check results
PREFLIGHT_RESULTS=()
PREFLIGHT_PASSED=true

preflight_record() {
    local name=$1
    local status=$2  # pass|fail|warn
    local detail=$3
    PREFLIGHT_RESULTS+=("${status}|${name}|${detail}")
    if [ "$status" = "fail" ]; then
        PREFLIGHT_PASSED=false
    fi
}

preflight_summary() {
    echo ""
    print_msg "$BLUE" "Pre-flight Check Summary:"
    echo "─────────────────────────────────────────"
    for result in "${PREFLIGHT_RESULTS[@]}"; do
        IFS='|' read -r status name detail <<< "$result"
        case $status in
            pass) print_msg "$GREEN" "  [PASS] $name" ;;
            fail) print_msg "$RED"   "  [FAIL] $name: $detail" ;;
            warn) print_msg "$YELLOW" "  [WARN] $name: $detail" ;;
        esac
    done
    echo "─────────────────────────────────────────"
    if [ "$PREFLIGHT_PASSED" = true ]; then
        print_msg "$GREEN" "All pre-flight checks passed"
    else
        print_msg "$RED" "Pre-flight checks FAILED - deployment aborted"
    fi
    echo ""
}

# Check DNS resolution for a hostname
check_dns_resolution() {
    local host=$1
    if host "$host" > /dev/null 2>&1; then
        preflight_record "DNS resolution ($host)" "pass" ""
    else
        preflight_record "DNS resolution ($host)" "fail" "Cannot resolve $host"
    fi
}

# Check SSH connectivity to a server
check_ssh_connectivity() {
    local server=$1
    local user=$2
    if ssh -o ConnectTimeout=10 -o BatchMode=yes "${user}@${server}" "echo ok" > /dev/null 2>&1; then
        preflight_record "SSH connectivity ($server)" "pass" ""
    else
        preflight_record "SSH connectivity ($server)" "fail" "Cannot connect via SSH to ${user}@${server}"
    fi
}

# Check available disk space (local or remote)
check_disk_space() {
    local server=$1
    local required_gb=$2

    local avail_kb
    if [ "$server" = "localhost" ]; then
        avail_kb=$(df / | awk 'NR==2 {print $4}')
    else
        avail_kb=$(ssh -o ConnectTimeout=10 "${DEPLOY_USER}@${server}" "df / | awk 'NR==2 {print \$4}'" 2>/dev/null)
    fi

    if [ -z "$avail_kb" ]; then
        preflight_record "Disk space ($server)" "fail" "Could not check disk space"
        return
    fi

    local avail_gb=$((avail_kb / 1048576))
    if [ "$avail_gb" -ge "$required_gb" ]; then
        preflight_record "Disk space ($server)" "pass" "${avail_gb}GB available"
    else
        preflight_record "Disk space ($server)" "fail" "Only ${avail_gb}GB available (need ${required_gb}GB)"
    fi
}

# Check Docker daemon is running (local or remote)
check_docker_daemon() {
    local server=$1

    local cmd="docker info > /dev/null 2>&1"
    if [ "$server" = "localhost" ]; then
        if eval "$cmd"; then
            preflight_record "Docker daemon (local)" "pass" ""
        else
            preflight_record "Docker daemon (local)" "fail" "Docker is not running"
        fi
    else
        if ssh -o ConnectTimeout=10 "${DEPLOY_USER}@${server}" "$cmd" 2>/dev/null; then
            preflight_record "Docker daemon ($server)" "pass" ""
        else
            preflight_record "Docker daemon ($server)" "fail" "Docker is not running on $server"
        fi
    fi
}

# Check for uncommitted git changes
check_git_clean_state() {
    local repo_root=$1
    local env=${2:-stage}

    # Determine which remote branch to track
    local remote_branch="main"
    if [ "$env" = "local" ]; then
        remote_branch="localdev"
    fi

    local status
    status=$(git -C "$repo_root" status --porcelain 2>/dev/null)
    if [ -z "$status" ]; then
        preflight_record "Git clean state" "pass" ""
    else
        local changed_count
        changed_count=$(echo "$status" | wc -l | tr -d ' ')
        preflight_record "Git clean state" "warn" "${changed_count} uncommitted changes"
    fi

    # Check if local is behind remote branch
    git -C "$repo_root" fetch origin "$remote_branch" --quiet 2>/dev/null
    local local_sha remote_sha
    local_sha=$(git -C "$repo_root" rev-parse HEAD 2>/dev/null)
    remote_sha=$(git -C "$repo_root" rev-parse "origin/${remote_branch}" 2>/dev/null)
    if [ "$local_sha" = "$remote_sha" ]; then
        preflight_record "Git sync (origin/$remote_branch)" "pass" ""
    else
        # For local env: auto-switch to localdev and pull if behind
        if [ "$env" = "local" ]; then
            local current_branch
            current_branch=$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null)
            if [ "$current_branch" != "$remote_branch" ]; then
                print_msg "$YELLOW" "  Switching to $remote_branch branch..."
                git -C "$repo_root" checkout "$remote_branch" 2>/dev/null || true
            fi
            local behind
            behind=$(git -C "$repo_root" rev-list --count HEAD..origin/"$remote_branch" 2>/dev/null || echo 0)
            if [ "$behind" -gt 0 ]; then
                print_msg "$YELLOW" "  HEAD is $behind commit(s) behind origin/$remote_branch — pulling..."
                git -C "$repo_root" pull origin "$remote_branch" --ff-only 2>/dev/null || true
            fi
            preflight_record "Git sync (origin/$remote_branch)" "pass" "auto-synced to origin/$remote_branch"
        else
            preflight_record "Git sync (origin/$remote_branch)" "warn" "Local HEAD differs from origin/$remote_branch"
        fi
    fi
}

# Check that env file exists
check_env_file() {
    local env_file=$1
    if [ -f "$env_file" ]; then
        preflight_record "Env file ($env_file)" "pass" ""
    else
        preflight_record "Env file ($env_file)" "fail" "File not found"
    fi
}

# Check compose file exists
check_compose_file() {
    local compose_file=$1
    if [ -f "$compose_file" ]; then
        preflight_record "Compose file ($compose_file)" "pass" ""
    else
        preflight_record "Compose file ($compose_file)" "fail" "File not found"
    fi
}

# Run all pre-flight checks for an environment
preflight_check() {
    local env=$1
    local target_server=$2
    local env_file=$3
    local compose_file=$4
    local repo_root=$5

    PREFLIGHT_RESULTS=()
    PREFLIGHT_PASSED=true

    print_msg "$BLUE" "Running pre-flight checks for $env..."
    echo ""

    # Required file checks
    check_compose_file "$compose_file"
    if [ "$env" != "local" ] || [ -f "$env_file" ]; then
        check_env_file "$env_file"
    fi

    # Git state
    check_git_clean_state "$repo_root" "$env"

    if [ "$target_server" = "localhost" ]; then
        # Local checks
        check_disk_space "localhost" "$MIN_DISK_SPACE_GB"
        check_docker_daemon "localhost"
    else
        # Remote checks
        check_dns_resolution "$target_server"
        check_ssh_connectivity "$target_server" "$DEPLOY_USER"
        # Only check disk/docker if SSH works
        if [ "$PREFLIGHT_PASSED" = true ]; then
            check_disk_space "$target_server" "$MIN_DISK_SPACE_GB"
            check_docker_daemon "$target_server"
        fi
    fi

    preflight_summary

    if [ "$PREFLIGHT_PASSED" = true ]; then
        return 0
    else
        return 1
    fi
}
