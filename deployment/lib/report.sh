#!/bin/bash
##############################################################################
# Deployment report generation
# Generates summary reports after deployment (success or failure)
##############################################################################

REPORT_DIR="${HOME}/.secondlayer/deploy_reports"

generate_deploy_report() {
    local env=$1
    local status=$2          # success|failure|rollback
    local backup_id=$3
    local start_time=$4
    local repo_root=$5

    mkdir -p "$REPORT_DIR"

    local end_time
    end_time=$(date +%s)
    local duration=$((end_time - start_time))
    local duration_min=$((duration / 60))
    local duration_sec=$((duration % 60))

    local git_sha
    git_sha=$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || echo "unknown")
    local git_branch
    git_branch=$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

    local report_file="${REPORT_DIR}/deploy_${env}_$(date +%Y%m%d_%H%M%S).txt"

    local status_icon
    case $status in
        success)  status_icon="SUCCESS" ;;
        failure)  status_icon="FAILED" ;;
        rollback) status_icon="ROLLED BACK" ;;
    esac

    cat > "$report_file" << EOF
═══════════════════════════════════════════
  DEPLOYMENT REPORT
═══════════════════════════════════════════

  Environment : $env
  Status      : $status_icon
  Timestamp   : $(date '+%Y-%m-%d %H:%M:%S %Z')
  Duration    : ${duration_min}m ${duration_sec}s
  Git SHA     : $git_sha
  Git Branch  : $git_branch
  Backup ID   : ${backup_id:-none}

───────────────────────────────────────────
  Pre-flight Checks
───────────────────────────────────────────
EOF

    # Append preflight results if available
    if [ ${#PREFLIGHT_RESULTS[@]} -gt 0 ]; then
        for result in "${PREFLIGHT_RESULTS[@]}"; do
            IFS='|' read -r rstatus rname rdetail <<< "$result"
            case $rstatus in
                pass) echo "  [PASS] $rname" >> "$report_file" ;;
                fail) echo "  [FAIL] $rname: $rdetail" >> "$report_file" ;;
                warn) echo "  [WARN] $rname: $rdetail" >> "$report_file" ;;
            esac
        done
    else
        echo "  (not available)" >> "$report_file"
    fi

    cat >> "$report_file" << EOF

───────────────────────────────────────────
  Smoke Tests
───────────────────────────────────────────
EOF

    # Append smoke test results if available
    if [ ${#SMOKE_RESULTS[@]} -gt 0 ]; then
        for result in "${SMOKE_RESULTS[@]}"; do
            IFS='|' read -r rstatus rname rdetail <<< "$result"
            case $rstatus in
                pass) echo "  [PASS] $rname" >> "$report_file" ;;
                fail) echo "  [FAIL] $rname: $rdetail" >> "$report_file" ;;
                warn) echo "  [WARN] $rname: $rdetail" >> "$report_file" ;;
            esac
        done
    else
        echo "  (not available)" >> "$report_file"
    fi

    echo "" >> "$report_file"
    echo "═══════════════════════════════════════════" >> "$report_file"

    # Print report to console
    echo ""
    cat "$report_file"
    echo ""
    print_msg "$BLUE" "Report saved to: $report_file"
}
