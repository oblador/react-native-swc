// Times `collect_file_bindings` — the full-file scan that runs once per file
// before the visitor pass to seed the closure analyser.

use criterion::{criterion_group, criterion_main, Criterion, Throughput};

use worklets::closure::collect_file_bindings;

#[path = "common.rs"]
mod common;

const SMALL_FIXTURE: &str = r#"
import { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { View } from "react-native";

const offset = 10;

export default function Box() {
  const styles = useAnimatedStyle(() => {
    'worklet';
    return { transform: [{ translateX: withTiming(offset) }] };
  });
  return <View style={styles} />;
}
"#;

const LARGE_FIXTURE: &str = include_str!("fixtures/screen.js");

fn bench(c: &mut Criterion) {
    let small = common::parse(SMALL_FIXTURE);
    let large = common::parse(LARGE_FIXTURE);

    let mut group = c.benchmark_group("closure");
    group.throughput(Throughput::Bytes(SMALL_FIXTURE.len() as u64));
    group.bench_function("collect_file_bindings_small", |b| {
        b.iter(|| collect_file_bindings(&small));
    });
    group.throughput(Throughput::Bytes(LARGE_FIXTURE.len() as u64));
    group.bench_function("collect_file_bindings_large", |b| {
        b.iter(|| collect_file_bindings(&large));
    });
    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
