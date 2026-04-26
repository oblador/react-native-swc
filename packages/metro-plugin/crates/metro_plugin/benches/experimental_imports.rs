use criterion::{criterion_group, criterion_main, Criterion, Throughput};

use metro_plugin::experimental_imports::rewrite_imports;

#[path = "common.rs"]
mod common;

const FIXTURE: &str = r#"
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import * as Animated from "react-native-reanimated";

export const styles = StyleSheet.create({
  root: { flex: 1 },
  label: { color: "black" },
});

export default function Hello() {
  return React.createElement(View, { style: styles.root },
    React.createElement(Text, { style: styles.label }, "hi"),
    React.createElement(Animated.View)
  );
}

export { Hello as Greeting };
export * from "./other";
"#;

fn bench(c: &mut Criterion) {
    let parsed = common::parse(FIXTURE);
    let mut group = c.benchmark_group("experimental_imports");
    group.throughput(Throughput::Bytes(FIXTURE.len() as u64));
    group.bench_function("typical_module", |b| {
        b.iter_batched(
            || parsed.clone(),
            |mut program| {
                rewrite_imports(&mut program);
                program
            },
            criterion::BatchSize::SmallInput,
        );
    });
    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
