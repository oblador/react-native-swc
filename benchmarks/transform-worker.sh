#!/bin/bash

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

hyperfine \
    --runs 5 \
    --warmup 1 \
    --parameter-list transformer swc,babel \
    --parameter-list project vanilla,expo \
    "TRANSFORMER={transformer} PROJECT={project} node \"$REPO_ROOT/benchmarks/transform.ts\""
