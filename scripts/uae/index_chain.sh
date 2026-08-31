#!/bin/bash
# Chained index walker: one background chain per litigation stage.
# Each Lambda invocation walks CHUNK pages, writes its rows to S3 and saves the
# OutSystems session state so the next invocation resumes with zero fast-forward.
set -u
SD="${UAE_WORK_DIR:-$(cd "$(dirname "$0")" && pwd)/work}"
mkdir -p "$SD"
B="${UAE_BUCKET:?set UAE_BUCKET}"
AWS="aws --profile ${UAE_PROFILE:-uae} --region ${UAE_REGION:-me-central-1}"
CHUNK=5000
LOG=$SD/index_chain.log
: > "$LOG"
say() { echo "$(date -u +%H:%M:%SZ) [$1] ${*:2}" >> "$LOG"; }

chain() {
    local S=$1 DELAY=$2 n=0 resume=""
    # pick up where a previous run left off: newest chunk in S3 + its saved state
    local last=$($AWS s3api list-objects-v2 --bucket "$B" --prefix "index/stage${S}_c" \
                 --query "Contents[].Key" --output text 2>/dev/null | tr '\t' '\n' \
                 | grep -oE 'c[0-9]+' | sort | tail -1)
    if [ -n "$last" ]; then
        n=$((10#${last#c}))
        local sk_prev=$(printf "state/stage%s_c%02d.json.gz" "$S" "$n")
        if $AWS s3 ls "s3://$B/$sk_prev" >/dev/null 2>&1; then
            resume="$sk_prev"
            say "$S" "resuming after chunk $n (state $sk_prev)"
        else
            say "$S" "chunk $n exists but no state - restarting stage from scratch"
            n=0
        fi
    fi
    while [ $n -lt ${UAE_MAX_CHUNKS:-80} ]; do
        n=$((n+1))
        local ck=$(printf "index/stage%s_c%02d.json.gz" "$S" "$n")
        local sk=$(printf "state/stage%s_c%02d.json.gz" "$S" "$n")
        local pay="{\"mode\":\"walk\",\"stage\":\"$S\",\"pages\":$CHUNK,\"delay\":$DELAY,\"timeout\":45,\"s3_key\":\"$ck\",\"save_state_key\":\"$sk\""
        [ -n "$resume" ] && pay="$pay,\"resume_state_key\":\"$resume\""
        pay="$pay}"
        say "$S" "chunk $n running synchronously (resume=${resume:-none})"
        local out="$SD/resp_stage${S}_c${n}.json"
        rm -f "$out"
        # sync invoke: async events were silently dying without writing anything
        $AWS lambda invoke --function-name uae-fetch \
             --cli-read-timeout 0 --cli-connect-timeout 60 \
             --cli-binary-format raw-in-base64-out --payload "$pay" "$out" >/dev/null 2>&1
        local summary=$(python3 -c "
import json,sys
try:
    d=json.load(open('$out'))
except Exception as e:
    print('NO RESPONSE (%s)' % e); raise SystemExit
print('ok=%s rows=%s last_page=%s stopped_early=%s err=%s%s' % (
    d.get('ok'), d.get('row_count'), d.get('last_page'), d.get('stopped_early'),
    d.get('err'), d.get('errorMessage','')))
" 2>&1)
        say "$S" "chunk $n returned: $summary"
        # a chunk can fail on a transient network error; retry it before giving up
        local tries=1
        while ! $AWS s3 ls "s3://$B/$ck" >/dev/null 2>&1; do
            if [ $tries -ge 4 ]; then
                say "$S" "chunk $n wrote no object after $tries tries - aborting chain"; return 1
            fi
            say "$S" "chunk $n wrote no object - retry $tries in 120s"
            sleep 120
            rm -f "$out"
            $AWS lambda invoke --function-name uae-fetch \
                 --cli-read-timeout 0 --cli-connect-timeout 60 \
                 --cli-binary-format raw-in-base64-out --payload "$pay" "$out" >/dev/null 2>&1
            tries=$((tries+1))
        done
        local sz=$($AWS s3 ls "s3://$B/$ck" | awk '{print $3}')
        say "$S" "chunk $n stored (${sz} bytes)"
        sleep 60   # COOLDOWN between chunks, be gentle with the portal
        if $AWS s3 ls "s3://$B/$sk" >/dev/null 2>&1; then
            resume="$sk"
        else
            say "$S" "no further state -> stage $S COMPLETE after $n chunks"; return 0
        fi
    done
    say "$S" "TRUNCATED: hit the ${UAE_MAX_CHUNKS:-80}-chunk cap without reaching the end"
    return 2
}

# Sequential: one stage at a time, no self-competition for the portal.
# Smallest first, so a whole stage completes early and depth effects show up clean.
say "ALL" "waiting up to 12 min for in-flight chunks to land"
for i in $(seq 1 24); do
    N=$($AWS s3api list-objects-v2 --bucket "$B" --prefix "index/stage" \
        --query "Contents[].Key" --output text 2>/dev/null | tr '\t' '\n' | grep -c "_c02" || true)
    [ "${N:-0}" -ge 3 ] && { say "ALL" "in-flight chunks landed ($N)"; break; }
    sleep 30
done

DELAY="${UAE_DELAY:-0.8}"
for S in ${UAE_STAGES:-5 3}; do
    say "ALL" "=== starting stage $S ==="
    chain "$S" "$DELAY"
    rc=$?
    say "ALL" "=== stage $S returned $rc ==="
    [ $rc -eq 2 ] && say "ALL" "WARNING: stage $S is INCOMPLETE (chunk cap) - rerun to continue"
done
say "ALL" "index chains finished"
