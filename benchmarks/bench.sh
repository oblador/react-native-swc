#!/bin/bash
# Run benchmarks comparing HEAD against a base ref. Same orchestration the
# `bench.yml` CI workflow runs — keep them in sync. The script builds both
# refs into independent git worktrees, then drives hyperfine + cargo bench
# from those, and renders a markdown report via `compare.ts`.
#
# Usage:
#   ./benchmarks/bench.sh
#       Compare HEAD against `git merge-base HEAD main`. Auto-detects which
#       benches to run from the diff: criterion benches only fire when their
#       crate's sources moved; transformer + bundle benches fire on any
#       packages/** change.
#
#   ./benchmarks/bench.sh --base origin/main
#       Pick a different base ref. The actual base commit is the merge-base
#       between HEAD and the named ref.
#
#   ./benchmarks/bench.sh --only transformer,metro-plugin
#       Run a specific subset. Names: metro-plugin, worklets-plugin,
#       transformer, bundle. Comma-separated.
#
#   ./benchmarks/bench.sh --skip-build
#       Reuse existing worktrees + their build outputs. Useful when iterating
#       on the bench harness itself or running the same benches repeatedly
#       without changing source. Cold first run takes 5–10 min for
#       pnpm install + WASM/TS build per worktree; subsequent runs amortise.
#
#   ./benchmarks/bench.sh --out report.md
#       Write the markdown report to a file in addition to stdout.
#
# Notes:
#   The criterion benches under `packages/{metro-plugin,worklets-plugin}/
#   crates/*/benches/` were added in a specific commit. If the base ref
#   predates that commit, those benches are skipped (with an explanatory
#   note in the output) — the transformer + bundle benches still run.
#
# Environment:
#   BENCH_WORKTREE_DIR   — where worktrees live (default: /tmp)
#   BENCH_RESULTS_DIR    — where intermediate JSON/markdown lands
#                          (default: <repo>/bench-results)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

BASE_REF="main"
HEAD_REF="HEAD"
ONLY=""
SKIP_BUILD=0
OUT=""
BENCH_WORKTREE_DIR="${BENCH_WORKTREE_DIR:-/tmp}"
RESULTS_DIR="${BENCH_RESULTS_DIR:-$REPO_ROOT/bench-results}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --base) BASE_REF="$2"; shift 2 ;;
        --head) HEAD_REF="$2"; shift 2 ;;
        --only) ONLY="$2"; shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        --out) OUT="$2"; shift 2 ;;
        -h|--help) sed -n '2,/^$/p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
done

command -v hyperfine >/dev/null || {
    echo "hyperfine not found on PATH (brew install hyperfine, or via mise)." >&2
    exit 1
}
command -v pnpm >/dev/null || { echo "pnpm not found on PATH." >&2; exit 1; }
command -v cargo >/dev/null || { echo "cargo not found on PATH." >&2; exit 1; }

cd "$REPO_ROOT"

HEAD_SHA="$(git rev-parse "$HEAD_REF")"
# Use merge-base if the user gave us a branch ref so the comparison is
# stable for the lifetime of the working branch even when main moves.
if BASE_SHA="$(git merge-base "$HEAD_REF" "$BASE_REF" 2>/dev/null)"; then
    :
else
    BASE_SHA="$(git rev-parse "$BASE_REF")"
fi

if [ "$HEAD_SHA" = "$BASE_SHA" ]; then
    echo "head and base resolve to the same commit ($HEAD_SHA); nothing to compare." >&2
    exit 0
fi

echo "Comparing:"
echo "  head: $HEAD_SHA  ($(git log -1 --format='%s' "$HEAD_SHA"))"
echo "  base: $BASE_SHA  ($(git log -1 --format='%s' "$BASE_SHA"))"
echo

HEAD_WT="$BENCH_WORKTREE_DIR/bench-head"
BASE_WT="$BENCH_WORKTREE_DIR/bench-base"

# ---------------------------------------------------------------------------
# Decide which benches to run.
# ---------------------------------------------------------------------------

if [ -n "$ONLY" ]; then
    BENCHES="$(echo "$ONLY" | tr ',' ' ')"
else
    CHANGED="$(git diff --name-only "$BASE_SHA" "$HEAD_SHA")"
    BENCHES=""
    # Per-crate criterion benches only run when their own sources move.
    echo "$CHANGED" | grep -qE '^packages/metro-plugin/|^Cargo\.|^rust-toolchain' \
        && BENCHES="$BENCHES metro-plugin"
    echo "$CHANGED" | grep -qE '^packages/worklets-plugin/|^Cargo\.|^rust-toolchain' \
        && BENCHES="$BENCHES worklets-plugin"
    # Transformer + bundle benches fire on any packages/** change because
    # they're the integration tests of the optimisation work.
    echo "$CHANGED" | grep -qE '^packages/|^Cargo\.|^benchmarks/transform\.ts|^benchmarks/compare\.ts' \
        && BENCHES="$BENCHES transformer"
    echo "$CHANGED" | grep -qE '^packages/|^examples/(vanilla|expo)/|^Cargo\.|^benchmarks/compare\.ts' \
        && BENCHES="$BENCHES bundle"
fi

BENCHES="$(echo "$BENCHES" | xargs)" # dedupe whitespace
if [ -z "$BENCHES" ]; then
    echo "No benches selected (the diff doesn't touch anything benchable)." >&2
    exit 0
fi

echo "Running: $BENCHES"
echo

runs() { echo "$BENCHES" | tr ' ' '\n' | grep -qx "$1"; }

# ---------------------------------------------------------------------------
# Build both refs into worktrees. Cold builds take a while; --skip-build
# reuses existing trees so iteration on the bench harness itself is cheap.
# ---------------------------------------------------------------------------

build_worktree() {
    local label="$1" sha="$2" wt="$3"
    if [ "$SKIP_BUILD" = 1 ] && [ -d "$wt" ]; then
        echo "==> Reusing $label worktree at $wt"
        return
    fi
    if [ -d "$wt" ]; then
        git worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
    fi
    echo "==> Building $label worktree at $wt"
    git worktree add "$wt" "$sha"
    (
        cd "$wt"
        pnpm install --frozen-lockfile
        pnpm run build
    )
}

build_worktree head "$HEAD_SHA" "$HEAD_WT"
build_worktree base "$BASE_SHA" "$BASE_WT"

mkdir -p "$RESULTS_DIR"
# Clear previous artefacts so the report is for THIS run only.
rm -f "$RESULTS_DIR"/transform-*.json "$RESULTS_DIR"/transform-*.md \
      "$RESULTS_DIR"/bundle-*.json "$RESULTS_DIR"/bundle-*.md \
      "$RESULTS_DIR"/size-*.json \
      "$RESULTS_DIR"/cargo-*.txt

# ---------------------------------------------------------------------------
# Criterion benches — cargo bench has no native ref-as-param, so we run
# twice and let `compare.ts` diff the bencher-format outputs.
# ---------------------------------------------------------------------------

bench_criterion() {
    local crate="$1" file_prefix="$2" benches_dir="$3"

    # The criterion benches were added in a specific commit. When the base
    # ref predates that commit there's nothing to compare against, and
    # `cargo bench --benches` falls through to libtest's bench harness on
    # the lib target — which doesn't grok `--output-format=bencher` and
    # blows up. Detect the missing directory and skip cleanly with a note
    # in the output instead.
    if [ ! -d "$HEAD_WT/$benches_dir" ]; then
        echo "==> Skipping $crate criterion bench: head has no $benches_dir/"
        return
    fi
    if [ ! -d "$BASE_WT/$benches_dir" ]; then
        echo "==> Skipping $crate criterion bench: base ref predates the criterion harness ($benches_dir/ missing in $BASE_WT)."
        return
    fi

    echo
    echo "=== Criterion: $crate ==="
    for ref in head base; do
        local wt="$HEAD_WT"; [ "$ref" = base ] && wt="$BASE_WT"
        (cd "$wt" && cargo bench -p "$crate" --benches -- --output-format=bencher) \
            | tee "$RESULTS_DIR/$file_prefix-$ref.txt"
    done
}

runs metro-plugin    && bench_criterion metro_plugin cargo-metro_plugin packages/metro-plugin/crates/metro_plugin/benches
runs worklets-plugin && bench_criterion worklets    cargo-worklets    packages/worklets-plugin/crates/worklets/benches

# ---------------------------------------------------------------------------
# Hyperfine: --parameter-list ref head,base flips between worktrees per run
# and computes the head/base ratio with native confidence intervals.
# ---------------------------------------------------------------------------

if runs transformer; then
    echo
    echo "=== Hyperfine: transformer ==="
    for project in vanilla expo; do
        hyperfine \
            --runs 5 --warmup 1 \
            --parameter-list ref head,base \
            --export-json     "$RESULTS_DIR/transform-$project.json" \
            --export-markdown "$RESULTS_DIR/transform-$project.md" \
            --command-name    "transform / $project / {ref}" \
            "cd $BENCH_WORKTREE_DIR/bench-{ref} && TRANSFORMER=swc PROJECT=$project node benchmarks/transform.ts"
    done
fi

if runs bundle; then
    echo
    echo "=== Hyperfine: bundle ==="
    for project in vanilla expo; do
        if [ "$project" = expo ]; then
            cmd="cd $BENCH_WORKTREE_DIR/bench-{ref}/examples/expo && TRANSFORMER=swc pnpm exec expo export --no-bytecode --platform ios --output-dir dist"
        else
            cmd="cd $BENCH_WORKTREE_DIR/bench-{ref}/examples/vanilla && TRANSFORMER=swc pnpm exec react-native bundle --entry-file index.js --platform ios --dev false --minify true --bundle-output bundle.js"
        fi
        hyperfine \
            --prepare 'rm -rf "${TMPDIR:-/tmp}"/metro-* 2>/dev/null || true' \
            --runs 3 --warmup 1 \
            --parameter-list ref head,base \
            --export-json     "$RESULTS_DIR/bundle-$project.json" \
            --export-markdown "$RESULTS_DIR/bundle-$project.md" \
            --command-name    "bundle / $project / {ref}" \
            "$cmd"
    done

    # Bundle-size capture. Each worktree has its bundle on disk after
    # hyperfine's last run; run hermesc against both and emit a single JSON.
    case "$(uname -s)" in
        Darwin) HERMESC_PLATFORM=osx-bin ;;
        Linux)  HERMESC_PLATFORM=linux64-bin ;;
        *) HERMESC_PLATFORM= ;;
    esac
    HERMESC="$HEAD_WT/examples/vanilla/node_modules/react-native/sdks/hermesc/$HERMESC_PLATFORM/hermesc"
    if [ -n "$HERMESC_PLATFORM" ] && [ -x "$HERMESC" ]; then
        for project in vanilla expo; do
            head_js=0 head_hbc=0 base_js=0 base_hbc=0
            for ref in head base; do
                local_wt="$HEAD_WT"; [ "$ref" = base ] && local_wt="$BASE_WT"
                if [ "$project" = expo ]; then
                    bundle=$(find "$local_wt/examples/expo/dist/_expo/static/js/ios" -maxdepth 1 \
                        \( -name 'entry-*.js' -o -name 'index-*.js' \) ! -name '*.hbc' 2>/dev/null | head -1)
                else
                    bundle="$local_wt/examples/vanilla/bundle.js"
                fi
                [ -f "$bundle" ] || continue
                "$HERMESC" -O -w -emit-binary -out "$bundle.hbc" "$bundle" >/dev/null
                eval "${ref}_js=\$(wc -c <\"\$bundle\" | tr -d ' ')"
                eval "${ref}_hbc=\$(wc -c <\"\$bundle.hbc\" | tr -d ' ')"
            done
            printf '{"head":{"js":%d,"hbc":%d},"base":{"js":%d,"hbc":%d}}\n' \
                "$head_js" "$head_hbc" "$base_js" "$base_hbc" \
                > "$RESULTS_DIR/size-$project.json"
            unset head_js head_hbc base_js base_hbc
        done
    else
        echo "(skipping bundle-size capture — hermesc not found)" >&2
    fi
fi

# ---------------------------------------------------------------------------
# Render report.
# ---------------------------------------------------------------------------

echo
echo "=== Comparison ==="
echo
if [ -n "$OUT" ]; then
    node --experimental-strip-types "$REPO_ROOT/benchmarks/compare.ts" \
        --dir "$RESULTS_DIR" --out "$OUT"
    cat "$OUT"
else
    node --experimental-strip-types "$REPO_ROOT/benchmarks/compare.ts" \
        --dir "$RESULTS_DIR"
fi
