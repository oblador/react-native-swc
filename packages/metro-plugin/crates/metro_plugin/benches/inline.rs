use criterion::{criterion_group, criterion_main, Criterion, Throughput};

use metro_plugin::inline::{inline_plugin, Options};

#[path = "common.rs"]
mod common;

const FIXTURE: &str = r#"
"use strict";
const Platform = require("react-native").Platform;

function describePlatform() {
  const tag = Platform.OS;
  const styles = Platform.select({
    ios: { fontSize: 14 },
    android: { fontSize: 16 },
    default: { fontSize: 12 },
  });
  if (Platform.OS === "ios") {
    return { tag, styles, native: true };
  }
  if (__DEV__) {
    console.log("dev", process.env.NODE_ENV);
  }
  return { tag, styles, native: false };
}

if (__DEV__) {
  describePlatform();
}

module.exports = describePlatform;
"#;

fn bench(c: &mut Criterion) {
    let parsed = common::parse(FIXTURE);
    let mut group = c.benchmark_group("inline");
    group.throughput(Throughput::Bytes(FIXTURE.len() as u64));
    group.bench_function("ios_unwrapped", |b| {
        b.iter_batched(
            || parsed.clone(),
            |mut program| {
                inline_plugin(
                    &mut program,
                    &Options {
                        inline_platform: true,
                        is_wrapped: false,
                        require_name: "require".into(),
                        platform: "ios".into(),
                    },
                );
                program
            },
            criterion::BatchSize::SmallInput,
        );
    });
    group.bench_function("ios_wrapped", |b| {
        b.iter_batched(
            || parsed.clone(),
            |mut program| {
                inline_plugin(
                    &mut program,
                    &Options {
                        inline_platform: true,
                        is_wrapped: true,
                        require_name: "require".into(),
                        platform: "ios".into(),
                    },
                );
                program
            },
            criterion::BatchSize::SmallInput,
        );
    });
    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
