#!/bin/bash
# Bundle one or more example apps under SWC vs Babel and report wall time +
# bundle size. Auto-detects the bundle tool (expo export when expo is in
# node_modules, vanilla react-native bundle otherwise) and the package runner
# (pnpm/yarn/npx based on lockfile).
#
# Usage:
#   ./benchmarks/bundle.sh vanilla
#   ./benchmarks/bundle.sh vanilla expo bluesky

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLES_DIR="$REPO_ROOT/examples"

if [ "$#" -eq 0 ]; then
    echo "usage: $0 <example>... (e.g. vanilla, expo, bluesky)" >&2
    exit 1
fi

case "$(uname -s)" in
    Darwin) HERMESC_PLATFORM=osx-bin ;;
    Linux)  HERMESC_PLATFORM=linux64-bin ;;
    *) echo "unsupported OS for hermesc: $(uname -s)" >&2; exit 1 ;;
esac

# Walk up looking for a lockfile so workspaces (e.g. examples/vanilla, whose
# lockfile lives at the repo root) get the right runner.
detect_runner() {
    local d=$1
    while [ "$d" != "/" ] && [ "$d" != "$REPO_ROOT/.." ]; do
        if [ -f "$d/pnpm-lock.yaml" ]; then echo "pnpm exec"; return; fi
        if [ -f "$d/yarn.lock" ]; then echo "yarn"; return; fi
        if [ -f "$d/package-lock.json" ]; then echo "npx"; return; fi
        d=$(dirname "$d")
    done
    echo "npx"
}

format_kb() {
    awk -v b="$1" 'BEGIN { printf "%.1f KB", b / 1024 }'
}

format_diff() {
    awk -v a="$1" -v b="$2" 'BEGIN { printf "%+.1f KB (%+.1f%%)", (a - b) / 1024, ((a - b) / b) * 100 }'
}

# Locate hermesc — RN 0.70+ ships it under react-native/sdks/hermesc; older
# layouts have it via the hermes-compiler package.
locate_hermesc() {
    local dir=$1
    local rn_bundled="$dir/node_modules/react-native/sdks/hermesc/$HERMESC_PLATFORM/hermesc"
    if [ -x "$rn_bundled" ]; then echo "$rn_bundled"; return; fi
    node -e "
        const path = require('path');
        try {
            const rn = path.dirname(require.resolve('react-native/package.json', { paths: ['$dir'] }));
            const hc = path.dirname(require.resolve('hermes-compiler/package.json', { paths: [rn] }));
            console.log(path.join(hc, 'hermesc/$HERMESC_PLATFORM/hermesc'));
        } catch (_) {}
    " 2>/dev/null
}

run_one() {
    local name=$1
    local dir
    dir="$EXAMPLES_DIR/$name"

    if [ ! -d "$dir/node_modules" ]; then
        echo "examples/$name is not set up. Run benchmarks/setup-$name.sh first." >&2
        return 1
    fi

    local bundler runner
    if [ -d "$dir/node_modules/expo" ]; then
        bundler="expo"
    else
        bundler="react-native"
    fi
    runner=$(detect_runner "$dir")

    local bundle_args
    if [ "$bundler" = expo ]; then
        bundle_args="expo export --no-bytecode --platform ios --output-dir dist-{transformer}"
    else
        # Auto-detect entry. Most RN apps use index.js; mattermost uses index.ts.
        local entry=""
        for ext in ts tsx js; do
            if [ -f "$dir/index.$ext" ]; then entry="index.$ext"; break; fi
        done
        if [ -z "$entry" ]; then
            echo "examples/$name: no index.{ts,tsx,js} found in $dir" >&2
            return 1
        fi
        bundle_args="react-native bundle --entry-file $entry --platform ios --dev false --minify true --bundle-output bundle-{transformer}.js"
    fi

    echo
    echo "=========================================="
    printf "  %s  (bundler: %s, runner: %s)\n" "$name" "$bundler" "$runner"
    echo "=========================================="

    hyperfine \
        --prepare "rm -rf \"${TMPDIR:-/tmp}\"/metro-* 2>/dev/null || true" \
        --runs 3 \
        --warmup 1 \
        --parameter-list transformer swc,babel \
        "cd \"$dir\" && TRANSFORMER={transformer} $runner $bundle_args"

    # Bundle size compare.
    local swc_bundle babel_bundle hermesc
    if [ "$bundler" = expo ]; then
        # Expo names the iOS bundle either entry-<hash>.js (default for an
        # `index.js` entry that exports via expo-router) or index-<hash>.js
        # (bluesky/expensify), depending on which entry file expo's CLI picks.
        # `find` is used over `ls "{entry,index}-*"` because the latter errors
        # on no-match and aborts the size step under `set -o pipefail`.
        swc_bundle=$(find "$dir/dist-swc/_expo/static/js/ios" -maxdepth 1 \
            \( -name 'entry-*.js' -o -name 'index-*.js' \) ! -name '*.hbc' 2>/dev/null | head -1)
        babel_bundle=$(find "$dir/dist-babel/_expo/static/js/ios" -maxdepth 1 \
            \( -name 'entry-*.js' -o -name 'index-*.js' \) ! -name '*.hbc' 2>/dev/null | head -1)
    else
        swc_bundle="$dir/bundle-swc.js"
        babel_bundle="$dir/bundle-babel.js"
    fi

    hermesc=$(locate_hermesc "$dir")
    if [ -z "$hermesc" ] || [ ! -x "$hermesc" ]; then
        echo
        echo "(skipping bundle-size compare — could not locate hermesc binary)" >&2
        return 0
    fi

    "$hermesc" -O -w -emit-binary -out "$swc_bundle.hbc"   "$swc_bundle"   >/dev/null
    "$hermesc" -O -w -emit-binary -out "$babel_bundle.hbc" "$babel_bundle" >/dev/null
    local swc_js swc_hbc babel_js babel_hbc
    swc_js=$(wc -c <"$swc_bundle"        | tr -d ' ')
    swc_hbc=$(wc -c <"$swc_bundle.hbc"   | tr -d ' ')
    babel_js=$(wc -c <"$babel_bundle"    | tr -d ' ')
    babel_hbc=$(wc -c <"$babel_bundle.hbc" | tr -d ' ')

    echo
    echo "Bundle size (iOS):"
    printf "  %-14s  %-22s  %s\n" "" "js" "hbc"
    printf "  %-14s  %-22s  %s\n" "swc"   "$(format_kb "$swc_js")"   "$(format_kb "$swc_hbc")"
    printf "  %-14s  %-22s  %s\n" "babel" "$(format_kb "$babel_js")" "$(format_kb "$babel_hbc")"
    printf "  %-14s  %-22s  %s\n" "diff"  "$(format_diff "$swc_js" "$babel_js")" "$(format_diff "$swc_hbc" "$babel_hbc")"
}

for name in "$@"; do
    run_one "$name"
done
