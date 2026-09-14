#!/bin/bash
# Tests for verify-release-assets.sh. The workflow step it belongs to only ever
# runs on a real tag push, so what is checked here is the shell logic alone,
# driven by a stub gh that answers with a canned release body. The timing of
# GitHub's own "starting" -> "uploaded" transition is not something this can
# say anything about.
#
#   ./scripts/verify-release-assets.test.sh
#
# Every case is run twice over: once against the script as written, where it
# must pass, and once against each deliberately broken copy at the bottom,
# where it must fail. A suite that stays green against a broken script is not
# testing anything, and that is the failure mode this one is most exposed to:
# most of its cases expect a non-zero exit, which a broken script can reach for
# the wrong reason. Hence both layers - every such case also asserts on what was
# printed, and the mutations below check that the cases as a whole still bite.
set -e

cd "$(dirname "$0")"
script=$PWD/verify-release-assets.sh

if ! command -v jq > /dev/null; then
    echo "jq is needed: the stub gh below answers with real JSON, so that the" >&2
    echo "jq expression in the script is exercised rather than mocked out" >&2
    exit 1
fi

# A hung script would otherwise hang the suite. macOS has neither timeout nor,
# unless coreutils is installed, gtimeout - there the guard is simply absent,
# which costs a hang rather than a wrong answer.
limit=()
if command -v timeout > /dev/null; then
    limit=(timeout 60)
elif command -v gtimeout > /dev/null; then
    limit=(gtimeout 60)
fi

failures=0
quiet=false

fail() {
    $quiet || echo "  FAIL: $*" >&2
    failures=$((failures + 1))
}

# $1 case name, $2 expected exit status, $3 file names in dist (space
# separated), rest: one canned API response body per gh call, the last one
# repeating for any call beyond the list. A body of "!" makes that call fail
# the way an unreachable API does.
#
# Asserted afterwards by the caller through $out (combined output) and $calls
# (how many times gh was asked).
run_case() {
    local name=$1 want=$2 dist=$3
    shift 3

    local work
    work=$(mktemp -d "${TMPDIR:-/tmp}/pockode-verify-test.XXXXXX")
    mkdir -p "$work/dist" "$work/bin"
    local f
    for f in $dist; do
        echo "binary" > "$work/dist/$f"
    done

    local n=0
    for body in "$@"; do
        n=$((n + 1))
        printf '%s' "$body" > "$work/response-$n.json"
    done
    echo "$n" > "$work/responses"
    echo 0 > "$work/calls"

    cat > "$work/bin/gh" <<'STUB'
#!/bin/bash
# Nothing else here can see which release was asked about, so a script that
# built the wrong URL would satisfy every assertion below. Spelled out rather
# than read from the same variables the script is handed, so that dropping one
# of them is a difference this can see.
case " $* " in
    *" repos/sijiaoh/pockode/releases/1 "*) ;;
    *)
        echo "gh: stub was asked for something else: $*" >&2
        exit 1
        ;;
esac
n=$(($(cat "$STUB_WORK/calls") + 1))
echo "$n" > "$STUB_WORK/calls"
last=$(cat "$STUB_WORK/responses")
[ "$n" -le "$last" ] || n=$last
body=$STUB_WORK/response-$n.json
if [ "$(cat "$body")" = "!" ]; then
    echo "gh: HTTP 502 reading release (stub)" >&2
    exit 1
fi
expr=
while [ $# -gt 0 ]; do
    if [ "$1" = "--jq" ]; then
        expr=$2
    fi
    shift
done
jq -r "$expr" "$body"
STUB
    chmod +x "$work/bin/gh"

    set +e
    out=$(cd "$work" && STUB_WORK=$work PATH="$work/bin:$PATH" \
        GITHUB_REPOSITORY=sijiaoh/pockode GITHUB_REF_NAME=v9.9.9 RELEASE_ID=1 \
        UPLOAD_POLL_SECONDS=1 UPLOAD_TIMEOUT_SECONDS=$TIMEOUT \
        "${limit[@]}" bash "$SCRIPT_UNDER_TEST" dist 2>&1)
    local got=$?
    set -e
    calls=$(cat "$work/calls")
    rm -rf "$work"

    if [ "$got" -ne "$want" ]; then
        fail "$name: expected exit $want, got $got. Output:"
        $quiet || printf '%s\n' "$out" | sed 's/^/    /' >&2
    fi
    CASE=$name
}

expect_output() {
    case "$out" in
        *"$1"*) ;;
        *)
            fail "$CASE: output does not mention '$1'. Output:"
            $quiet || printf '%s\n' "$out" | sed 's/^/    /' >&2
            ;;
    esac
}

expect_calls() {
    [ "$calls" -eq "$1" ] || fail "$CASE: expected $1 gh call(s), got $calls"
}

assets() {
    # $@: "name:state" pairs, rendered as the fields of the release body that
    # this script reads.
    local sep= out="{\"assets\":["
    local pair
    for pair in "$@"; do
        out="$out$sep{\"name\":\"${pair%:*}\",\"state\":\"${pair#*:}\"}"
        sep=,
    done
    echo "$out]}"
}

DONE=$(assets checksums.txt:uploaded pockode-linux-amd64:uploaded)
PARTIAL=$(assets checksums.txt:uploaded pockode-linux-amd64:starting)

suite() {
    SCRIPT_UNDER_TEST=$1

    # Nothing to wait for: the first answer is already complete, and a second
    # poll would be a wasted round trip.
    TIMEOUT=10 run_case "already uploaded" 0 "checksums.txt pockode-linux-amd64" "$DONE"
    expect_calls 1

    # The case a strict equality check would have turned into a false red.
    TIMEOUT=10 run_case "uploaded on the third poll" 0 "checksums.txt pockode-linux-amd64" \
        "$PARTIAL" "$PARTIAL" "$DONE"
    expect_calls 3

    # Waits, then gives up - and says which asset is stuck in what state,
    # rather than only that a timeout elapsed.
    TIMEOUT=1 run_case "never finishes uploading" 1 "checksums.txt pockode-linux-amd64" "$PARTIAL"
    expect_output "pockode-linux-amd64: state=starting"

    # An unreachable API must not read as a release that simply has no assets
    # in flight, and the report has to name that cause: "short a binary" sends
    # whoever reads it to the build.
    TIMEOUT=10 run_case "gh itself fails" 1 "checksums.txt pockode-linux-amd64" "!"
    expect_output "could not read the assets"

    # Both sides of the diff are empty here, so the diff agrees.
    TIMEOUT=10 run_case "empty dist" 1 "" "$(assets)"
    expect_output "is empty"

    TIMEOUT=10 run_case "release is short an asset" 1 "checksums.txt pockode-linux-amd64" \
        "$(assets checksums.txt:uploaded)"
    expect_output "does not carry exactly"
}

echo "== the script as written =="
suite "$script"
if [ "$failures" -ne 0 ]; then
    echo "$failures assertion(s) failed" >&2
    exit 1
fi
echo "  all cases pass"

# Each entry breaks one property on purpose; the suite above has to notice.
# Ranges rather than line numbers so an edit to the script does not silently
# turn a mutation into a no-op - and the copy is compared afterwards to catch
# the case where it did anyway.
mutations=(
    'stops filtering on state|s/\$1 != "uploaded"/1 == 2/'
    'lets the timeout pass instead of failing|/still has assets that have not finished/,/^ *exit 1$/ s/^\( *\)exit 1$/\1break/'
    'swallows a failing gh|/could not read the assets/,/exit 1/ s/.*/:/'
    'drops the empty-dist assertion|/is empty: the build produced/,/exit 1/ s/.*/:/'
    'drops the name diff|/does not carry exactly/,/exit 1/ s/.*/:/'
    'asks about the wrong release|s/releases\/\$RELEASE_ID/releases\/999/'
)

echo
echo "== mutations, each of which must be caught =="
survivors=0
for mutation in "${mutations[@]}"; do
    label=${mutation%%|*}
    expr=${mutation#*|}
    mutant=$(mktemp "${TMPDIR:-/tmp}/pockode-verify-mutant.XXXXXX")
    sed "$expr" "$script" > "$mutant"
    if cmp -s "$script" "$mutant"; then
        echo "  FAIL: '$label' changed nothing - the pattern no longer matches" >&2
        survivors=$((survivors + 1))
        rm -f "$mutant"
        continue
    fi

    failures=0
    quiet=true
    suite "$mutant"
    quiet=false
    rm -f "$mutant"

    if [ "$failures" -eq 0 ]; then
        echo "  SURVIVED: $label" >&2
        survivors=$((survivors + 1))
    else
        echo "  caught ($failures assertion(s)): $label"
    fi
done

if [ "$survivors" -ne 0 ]; then
    echo "$survivors mutation(s) went unnoticed" >&2
    exit 1
fi
echo
echo "all cases pass, every mutation caught"
