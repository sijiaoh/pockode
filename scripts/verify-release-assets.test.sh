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
# the way an unreachable API does, "!!" makes it fail without printing a
# reason, and a body prefixed with "!warn" answers normally while writing to
# stderr the way gh does when it has a notice to pass on.
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
case "$(cat "$body")" in
    '!')
        echo "gh: HTTP 502 reading release (stub)" >&2
        exit 1
        ;;
    '!!') exit 1 ;;
    '!warn'*)
        echo "gh: warning: this endpoint is deprecated (stub)" >&2
        stripped=$STUB_WORK/response-$n.stripped
        sed '1s/^!warn//' "$body" > "$stripped"
        body=$stripped
        ;;
esac
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

    # A fractional poll is what keeps the cases that wait out a deadline - and
    # the suite runs every case fifteen times over, once as written and once
    # per mutation - from spending whole seconds a round: measured, about
    # eighty-five seconds this way against about two minutes twenty at a
    # one-second poll. The deadline itself still has to be whole, since date +%s
    # is what the script compares it against. Only this suite ever passes a
    # fraction, and only the Linux job runs this suite, so the BSD sleep on the
    # platform the gate itself runs on is never handed one.
    set +e
    out=$(cd "$work" && STUB_WORK=$work PATH="$work/bin:$PATH" \
        GITHUB_REPOSITORY=sijiaoh/pockode GITHUB_REF_NAME=v9.9.9 RELEASE_ID=1 \
        UPLOAD_POLL_SECONDS=0.2 UPLOAD_TIMEOUT_SECONDS=$TIMEOUT \
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

# What a failure does not say matters as much as what it does: the two deadline
# reports name different causes and have to stay apart, and neither of them may
# come out as the name diff's "short a binary". Each of those wrong answers
# points whoever reads it at a different half of the system.
expect_no_output() {
    case "$out" in
        *"$1"*)
            fail "$CASE: output should not mention '$1'. Output:"
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

# TIMEOUT=5 below means "more than this case needs": at the poll rate above that
# is upwards of twenty rounds, and no case here wants more than three. It is not
# larger still because a gh that never answers now spends the whole budget
# rather than exiting at once - which the wrong-release mutation makes every
# case do, and that mutation is the longest thing this suite does.
suite() {
    SCRIPT_UNDER_TEST=$1

    # Nothing to wait for: the first answer is already complete, and a second
    # poll would be a wasted round trip.
    TIMEOUT=5 run_case "already uploaded" 0 "checksums.txt pockode-linux-amd64" "$DONE"
    expect_calls 1

    # The case a strict equality check would have turned into a false red.
    TIMEOUT=5 run_case "uploaded on the third poll" 0 "checksums.txt pockode-linux-amd64" \
        "$PARTIAL" "$PARTIAL" "$DONE"
    expect_calls 3

    # Waits, then gives up - and says which asset is stuck in what state,
    # rather than only that a timeout elapsed.
    TIMEOUT=1 run_case "never finishes uploading" 1 "checksums.txt pockode-linux-amd64" "$PARTIAL"
    expect_output "pockode-linux-amd64: state=starting"
    expect_no_output "could not read the assets"

    # The point of retrying at all: the window is several calls wide, so one
    # unreachable call must not be the end of the release.
    TIMEOUT=5 run_case "gh fails twice, then answers" 0 "checksums.txt pockode-linux-amd64" \
        "!" "!" "$DONE"
    expect_calls 3
    # Passing silently would hide that the release nearly did not happen, and
    # the job log is the only place that could ever show it.
    expect_output "retrying until the deadline"

    # Capturing gh's stderr for the deadline report took it out of the job
    # log, and a round that answers has no report to put it in - so whatever
    # gh has to say about the endpoint this gate depends on has to be handed
    # on here or it is lost. Exiting 0 is half the assertion: what a
    # successful call said is a note, not a reason to keep waiting.
    TIMEOUT=5 run_case "gh warns on a call that answers" 0 "checksums.txt pockode-linux-amd64" \
        "!warn$DONE"
    expect_calls 1
    expect_output "this endpoint is deprecated"
    expect_no_output "retrying until the deadline"

    # An unreachable API must not read as a release that simply has no assets
    # in flight, and the report has to name that cause: "short a binary" sends
    # whoever reads it to the build. Nor may it read as a slow upload - which
    # is why the last call's own words have to come back out.
    TIMEOUT=1 run_case "gh fails until the deadline" 1 "checksums.txt pockode-linux-amd64" "!"
    expect_output "could not read the assets"
    expect_output "HTTP 502 reading release (stub)"
    expect_no_output "still has assets"

    # A non-zero exit with nothing on stderr is a lost round too, and the only
    # thing that says so is the emptiness of the reason - which is also what
    # the loop reads as "this round answered". Without a stand-in for it the
    # wait would end on the first such call, and a release nobody managed to
    # ask about would come out as one short a binary.
    TIMEOUT=1 run_case "gh fails without saying why" 1 "checksums.txt pockode-linux-amd64" "!!"
    expect_output "could not read the assets"
    expect_no_output "does not carry exactly"

    # Both sides of the diff are empty here, so the diff agrees.
    TIMEOUT=5 run_case "empty dist" 1 "" "$(assets)"
    expect_output "is empty"

    TIMEOUT=5 run_case "release is short an asset" 1 "checksums.txt pockode-linux-amd64" \
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
# Addressed by what the script says rather than by line number, so an edit to
# it does not silently turn a mutation into a no-op - and the copy is compared
# afterwards to catch the case where it did anyway.
mutations=(
    'stops filtering on state|s/\$1 != "uploaded"/1 == 2/'
    'lets the timeout pass instead of failing|/still has assets that have not finished/,/^ *exit 1$/ s/^\( *\)exit 1$/\1break/'
    'lets a failing gh out as a release with nothing in flight|s/ && \[ -z "\$gh_error" \]//'
    'gives up on the first failing gh instead of retrying|/gh_error=\$(cat/ s/^\( *\).*/\1exit 1/'
    'reports a stuck asset as a gh failure|/-ge "\$deadline"/,/^        exit 1$/ s/\[ -n "\$gh_error" \]/true/'
    'reports a failing gh as a stuck asset|/-ge "\$deadline"/,/^        exit 1$/ s/\[ -n "\$gh_error" \]/false/'
    'retries a lost round without saying so|s/^\( *\)echo "no answer about/\1: "no answer about/'
    'never clears the reason once a call succeeds|s/^    gh_error=$/    :/'
    'takes a silent gh failure for an answer|/gh exited non-zero without printing a reason/ s/^\( *\).*/\1:/'
    'drops what a gh call that answered still said|s/elif \[ -s "\$tmp\/gh-error.txt" \]/elif false/'
    'drops the reason the last gh call gave|/printf .%s.n. "\$gh_error"/ s/^\( *\).*/\1:/'
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
