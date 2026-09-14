#!/bin/bash
set -e

# Checks that a draft release carries exactly what dist/ built, and that every
# asset has finished uploading, before release.yml publishes it. Split out of
# the workflow so the logic can be tested without pushing a tag - see
# verify-release-assets.test.sh, which runs it against a stubbed gh.
#
# Usage: verify-release-assets.sh <dist-dir>
# Reads GH_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME and RELEASE_ID from the
# environment, the way the workflow step supplies them.

# GitHub reports an asset it is still receiving as "starting", and such an asset
# already appears in the list under its final name - so comparing names alone
# passes a release carrying a half-written binary. Nobody here has measured
# whether that state is still observable once action-gh-release has returned,
# which is why this waits instead of demanding "uploaded" outright: with no
# transition to wait out, the first poll passes and nothing is spent.
#
# The 120s cap comes from the job's budget rather than from a measurement of
# GitHub's bookkeeping, since there is no such measurement. release.yml sets
# timeout-minutes: 15, and its ten most recent runs each finished in 2-3
# minutes end to end, so roughly twelve of those minutes go unused. Staying
# well inside them is what makes a stuck asset come out as the named error
# below instead of as a killed job, which would say nothing about the cause.
# The tests override both values to keep their own runs short.
UPLOAD_TIMEOUT_SECONDS=${UPLOAD_TIMEOUT_SECONDS:-120}
UPLOAD_POLL_SECONDS=${UPLOAD_POLL_SECONDS:-5}

dist_dir=${1:?usage: $0 <dist-dir>}

# The workflow step is the only caller, but it supplies these through the
# environment rather than as arguments, so an empty one gets no further than
# a URL of repos//releases/ and an error about the response shape.
: "${GITHUB_REPOSITORY:?is not set}"
: "${GITHUB_REF_NAME:?is not set}"
: "${RELEASE_ID:?is not set}"

# Spelled out with a template because release.yml runs this on macOS, and the
# BSD mktemp there takes no bare -d: it wants a template or nothing at all.
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pockode-release-assets.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

ls "$dist_dir" | sort > "$tmp/expected.txt"
# An empty dist/ makes both sides of the diff empty, and diff then agrees: the
# one way this check passes while the release carries nothing, which is the
# accident it exists to catch. build.sh can get there without failing - it
# warns about exactly that for an absolute OUTPUT_DIR.
#
# This one assertion also covers the pipeline above, which the gh call below
# deliberately avoids being: without pipefail an ls that fails leaves sort's
# successful status and empty output behind, and empty output is what this
# refuses. The gh call has no such backstop - empty is a state a release can
# legitimately be in while its assets are still arriving.
if ! [ -s "$tmp/expected.txt" ]; then
    echo "$dist_dir is empty: the build produced no release assets" >&2
    exit 1
fi

deadline=$(($(date +%s) + UPLOAD_TIMEOUT_SECONDS))
while true; do
    # Not a pipeline: this script runs under -e without pipefail, so a gh that
    # fails inside one would hand its own status to the next command and leave
    # the empty output behind, which reads exactly like a release with no
    # assets in progress.
    if ! gh api "repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID" \
        --jq '.assets[] | "\(.state)\t\(.name)"' > "$tmp/assets.txt"; then
        echo "could not read the assets of release $GITHUB_REF_NAME" >&2
        exit 1
    fi

    pending=$(awk -F'\t' '$1 != "uploaded"' "$tmp/assets.txt")
    if [ -z "$pending" ]; then
        break
    fi

    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "release $GITHUB_REF_NAME still has assets that have not finished" \
            "uploading after ${UPLOAD_TIMEOUT_SECONDS}s:" >&2
        awk -F'\t' '{ printf "  %s: state=%s\n", $2, $1 }' <<< "$pending" >&2
        exit 1
    fi
    sleep "$UPLOAD_POLL_SECONDS"
done

# The third and last pipeline without pipefail, safe for the same reason as the
# first: a cut that failed would leave uploaded.txt empty, and expected.txt is
# known non-empty by here, so the diff below still refuses it.
cut -f2 "$tmp/assets.txt" | sort > "$tmp/uploaded.txt"
if ! diff -u "$tmp/expected.txt" "$tmp/uploaded.txt"; then
    echo "release $GITHUB_REF_NAME does not carry exactly what $dist_dir built" >&2
    exit 1
fi
