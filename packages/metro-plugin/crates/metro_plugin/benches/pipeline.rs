// Mirrors `wasm_plugin::process_transform`'s pass order with all four passes
// enabled — what production sets via `src/swc.ts`. Measures the metro-plugin's
// total contribution to a single file's transform.

use criterion::{criterion_group, criterion_main, Criterion, Throughput};
use rustc_hash::FxHashMap;
use swc_core::atoms::Atom;

use metro_plugin::{constant_folding, experimental_imports, inline, inline_requires};

#[path = "common.rs"]
mod common;

const FIXTURE: &str = r#"
import React from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import * as Animated from "react-native-reanimated";

const __DEV__ = false;

const styles = StyleSheet.create({
  root: { flex: 1 },
  label: { color: Platform.OS === "ios" ? "black" : "white" },
});

export default function Screen(props) {
  if (__DEV__) {
    console.log("rendering", Platform.OS);
  }
  const message = Platform.select({
    ios: "iOS device",
    android: "Android device",
    default: "Unknown",
  });
  return React.createElement(View, { style: styles.root },
    React.createElement(Text, { style: styles.label }, message),
    React.createElement(Animated.View, null, props.children)
  );
}

export const Tag = "screen";
"#;

fn run_pipeline(mut program: swc_core::ecma::ast::Program) -> swc_core::ecma::ast::Program {
    experimental_imports::rewrite_imports(&mut program);
    let mut envs: FxHashMap<Atom, String> = FxHashMap::default();
    envs.insert(Atom::from("NODE_ENV"), "production".into());
    inline::inline_plugin(
        &mut program,
        &inline::Options {
            inline_platform: true,
            is_wrapped: false,
            require_name: "require".into(),
            platform: "ios".into(),
            dev: false,
            envs,
        },
    );
    inline_requires::inline_requires(&mut program, &inline_requires::Options::default());
    constant_folding::constant_folding(&mut program);
    program
}

fn bench(c: &mut Criterion) {
    let parsed = common::parse(FIXTURE);
    let mut group = c.benchmark_group("pipeline");
    group.throughput(Throughput::Bytes(FIXTURE.len() as u64));
    group.bench_function("all_passes", |b| {
        b.iter_batched(
            || parsed.clone(),
            run_pipeline,
            criterion::BatchSize::SmallInput,
        );
    });
    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
