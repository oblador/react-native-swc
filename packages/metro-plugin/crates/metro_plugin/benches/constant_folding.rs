use criterion::{criterion_group, criterion_main, Criterion, Throughput};

use metro_plugin::constant_folding::constant_folding;

#[path = "common.rs"]
mod common;

const FIXTURE: &str = r#"
"use strict";

const __DEV__ = false;

if (__DEV__) {
  console.log("debug only");
  fetch("/_debug").then(function (r) { return r.text(); });
}

const tag = "ios" === "ios" ? "native" : "other";
const flag = false || true;
const compute = 2 + 3 * 4 - 1;

function pickOption(value) {
  switch (value) {
    case "ios": return { os: "ios" };
    case "android": return { os: "android" };
    default: return { os: "unknown" };
  }
}

if (false) {
  throw new Error("dead code");
} else if (true) {
  module.exports = { tag, flag, compute, pickOption };
}

const debugBranch = (function () {
  if (__DEV__) {
    return "with logging";
  }
  return "no logging";
})();

module.exports.debugBranch = debugBranch;
"#;

fn bench(c: &mut Criterion) {
    let parsed = common::parse(FIXTURE);
    let mut group = c.benchmark_group("constant_folding");
    group.throughput(Throughput::Bytes(FIXTURE.len() as u64));
    group.bench_function("typical", |b| {
        b.iter_batched(
            || parsed.clone(),
            |mut program| {
                constant_folding(&mut program);
                program
            },
            criterion::BatchSize::SmallInput,
        );
    });
    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
