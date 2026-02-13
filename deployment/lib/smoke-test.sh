#!/bin/bash
##############################################################################
# Post-deployment smoke tests
# Verifies deployment health after containers are started
##############################################################################

# How long to wait for containers to stabilize (seconds)
SMOKE_TEST_WAIT=${SMOKE_TEST_WAIT:-30}
# How many times to retry health checks
SMOKE_TEST_RETRIES=${SMOKE_TEST_RETRIES:-3}
# Delay between retries (seconds)
SMOKE_TEST_RETRY_DELAY=${SMOKE_TEST_RETRY_DELAY:-10}

SMOKE_RESULTS=()
SMOKE_PASSED=true

smoke_record() {
    local name=$1
    local status=$2  # pass|fail|warn
    local detail=$3
    SMOKE_RESULTS+=("${status}|${name}|${detail}")
    if [ "$status" = "fail" ]; then
        SMOKE_PASSED=false
    fi
}

smoke_summary() {
    echo ""
    print_msg "$BLUE" "Smoke Test Results:"
    echo "─────────────────────────────────────────"
    for result in "${SMOKE_RESULTS[@]}"; do
        IFS='|' read -r status name detail <<< "$result"
        case $status in
            pass) print_msg "$GREEN" "  [PASS] $name" ;;
            fail) print_msg "$RED"   "  [FAIL] $name: $detail" ;;
            warn) print_msg "$YELLOW" "  [WARN] $name: $detail" ;;
        esac
    done
    echo "─────────────────────────────────────────"
    if [ "$SMOKE_PASSED" = true ]; then
        print_msg "$GREEN" "All smoke tests passed"
    else
        print_msg "$RED" "Smoke tests FAILED"
    fi
    echo ""
}

# Check that all expected containers are running
check_containers_running() {
    local env=$1
    local target_server=$2
    local compose_file=$3
    local env_file=$4

    local env_short
    case $env in
        stage|staging) env_short="stage" ;;
        dev|development) env_short="dev" ;;
        local) env_short="local" ;;
    esac

    local ps_cmd="docker ps --filter 'name=-${env_short}' --format '{{.Names}}\t{{.Status}}'"

    local output
    if [ "$target_server" = "localhost" ]; then
        output=$(eval "$ps_cmd" 2>/dev/null)
    else
        output=$(ssh "${DEPLOY_USER}@${target_server}" "$ps_cmd" 2>/dev/null)
    fi

    if [ -z "$output" ]; then
        smoke_record "Containers running ($env)" "fail" "No containers found"
        return 1
    fi

    local all_healthy=true
    while IFS=$'\t' read -r name status; do
        if echo "$status" | grep -qi "up"; then
            smoke_record "Container $name" "pass" "$status"
        elif echo "$status" | grep -qi "restarting"; then
            smoke_record "Container $name" "fail" "Restarting - $status"
            all_healthy=false
        else
            # Skip init/migration containers that exited with 0
            if echo "$status" | grep -qi "exited (0)"; then
                continue
            fi
            smoke_record "Container $name" "fail" "$status"
            all_healthy=false
        fi
    done <<< "$output"

    $all_healthy
}

# Check HTTP health endpoint with retries
check_http_health() {
    local env=$1
    local target_server=$2

    local urls=()
    case $env in
        local)
            urls=("http://localhost:3000/health")
            ;;
        stage|staging)
            urls=("https://stage.legal.org.ua/health" "https://legal.org.ua/health" "https://mcp.legal.org.ua/health")
            ;;
    esac

    local all_passed=true
    for url in "${urls[@]}"; do
        local attempt=1
        local passed=false
        while [ $attempt -le $SMOKE_TEST_RETRIES ]; do
            if curl -skf --max-time 10 "$url" > /dev/null 2>&1; then
                smoke_record "HTTP health ($url)" "pass" ""
                passed=true
                break
            fi
            if [ $attempt -lt $SMOKE_TEST_RETRIES ]; then
                print_msg "$YELLOW" "  Health check attempt $attempt failed for $url, retrying in ${SMOKE_TEST_RETRY_DELAY}s..."
                sleep "$SMOKE_TEST_RETRY_DELAY"
            fi
            attempt=$((attempt + 1))
        done
        if [ "$passed" = false ]; then
            smoke_record "HTTP health ($url)" "fail" "No response after $SMOKE_TEST_RETRIES attempts"
            all_passed=false
        fi
    done

    $all_passed
}

# Check frontend is accessible
check_frontend_health() {
    local env=$1

    local urls=()
    case $env in
        local)
            urls=("https://localdev.legal.org.ua")
            ;;
        stage|staging)
            urls=("https://stage.legal.org.ua" "https://legal.org.ua" "https://mcp.legal.org.ua")
            ;;
    esac

    for url in "${urls[@]}"; do
        if curl -skf --max-time 10 "$url" > /dev/null 2>&1; then
            smoke_record "Frontend ($url)" "pass" ""
        else
            smoke_record "Frontend ($url)" "warn" "Not responding (may need DNS propagation)"
        fi
    done
}

# Check database connectivity via container exec
check_db_connectivity() {
    local env=$1
    local target_server=$2

    local env_short
    case $env in
        stage|staging) env_short="stage" ;;
        dev|development) env_short="dev" ;;
        local) env_short="local" ;;
    esac

    local db_name="secondlayer"
    if [ "$env_short" = "local" ]; then
        db_name="secondlayer_local"
    fi

    local db_cmd="docker exec secondlayer-postgres-${env_short} psql -U secondlayer -d ${db_name} -c 'SELECT 1' > /dev/null 2>&1"

    local result
    if [ "$target_server" = "localhost" ]; then
        result=$(eval "$db_cmd" 2>&1 && echo "ok" || echo "fail")
    else
        result=$(ssh "${DEPLOY_USER}@${target_server}" "$db_cmd" 2>&1 && echo "ok" || echo "fail")
    fi

    if echo "$result" | grep -q "ok"; then
        smoke_record "Database connectivity ($env)" "pass" ""
    else
        smoke_record "Database connectivity ($env)" "warn" "Could not verify (container name may differ)"
    fi
}

# Check for containers in restart loop
check_restart_loops() {
    local env=$1
    local target_server=$2

    local env_short
    case $env in
        stage|staging) env_short="stage" ;;
        dev|development) env_short="dev" ;;
        local) env_short="local" ;;
    esac

    local restart_cmd="docker ps --filter 'name=-${env_short}' --format '{{.Names}} {{.Status}}' | grep -i 'restarting' || true"

    local output
    if [ "$target_server" = "localhost" ]; then
        output=$(eval "$restart_cmd" 2>/dev/null)
    else
        output=$(ssh "${DEPLOY_USER}@${target_server}" "$restart_cmd" 2>/dev/null)
    fi

    if [ -n "$output" ]; then
        smoke_record "Restart loops" "fail" "Containers restarting: $output"
        return 1
    else
        smoke_record "Restart loops" "pass" ""
        return 0
    fi
}

# Run all smoke tests
run_smoke_tests() {
    local env=$1
    local target_server=$2
    local compose_file=$3
    local env_file=$4

    SMOKE_RESULTS=()
    SMOKE_PASSED=true

    print_msg "$BLUE" "Waiting ${SMOKE_TEST_WAIT}s for containers to stabilize..."
    sleep "$SMOKE_TEST_WAIT"

    print_msg "$BLUE" "Running smoke tests for $env..."

    # Container checks
    check_containers_running "$env" "$target_server" "$compose_file" "$env_file"
    check_restart_loops "$env" "$target_server"

    # HTTP checks
    check_http_health "$env" "$target_server"
    check_frontend_health "$env"

    # DB check
    check_db_connectivity "$env" "$target_server"

    smoke_summary

    if [ "$SMOKE_PASSED" = true ]; then
        return 0
    else
        return 1
    fi
}
