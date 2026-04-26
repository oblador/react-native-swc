// End-to-end bench for the worklets plugin's main visitor pass.
// Mirrors what `wasm_plugin::process_transform` does on each file:
// `collect_file_bindings` then `program.visit_mut_with(&mut plugin)`.

use criterion::{criterion_group, criterion_main, Criterion, Throughput};

use swc_core::ecma::visit::VisitMutWith;
use worklets::closure::collect_file_bindings;
use worklets::{PluginOptions, WorkletsPlugin};

#[path = "common.rs"]
mod common;

const SMALL_FIXTURE: &str = r#"
import { useAnimatedStyle, withTiming, useSharedValue } from "react-native-reanimated";
import { Animated, View } from "react-native";

export default function Box({ to }) {
  const x = useSharedValue(0);
  const styles = useAnimatedStyle(() => {
    return { transform: [{ translateX: withTiming(x.value + to) }] };
  });
  return <Animated.View style={styles} />;
}
"#;

const LARGE_FIXTURE: &str = include_str!("fixtures/screen.js");

fn run_fixture(label: &str, code: &str, c: &mut Criterion) {
    let parsed = common::parse(code);
    let file_bindings = collect_file_bindings(&parsed);

    let mut group = c.benchmark_group("plugin");
    group.throughput(Throughput::Bytes(code.len() as u64));
    group.bench_function(label, |b| {
        b.iter_batched(
            || parsed.clone(),
            |mut program| {
                let mut plugin = WorkletsPlugin::new(PluginOptions::default(), "/dev/null", false);
                plugin.file_bindings = file_bindings.clone();
                program.visit_mut_with(&mut plugin);
                program
            },
            criterion::BatchSize::SmallInput,
        );
    });
    group.finish();
}

fn bench(c: &mut Criterion) {
    run_fixture("small", SMALL_FIXTURE, c);
    run_fixture("large", LARGE_FIXTURE, c);
}

criterion_group!(benches, bench);
criterion_main!(benches);
