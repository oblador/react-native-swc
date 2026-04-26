use criterion::{criterion_group, criterion_main, Criterion, Throughput};

use metro_plugin::inline_requires::{inline_requires, Options};

#[path = "common.rs"]
mod common;

const FIXTURE: &str = r#"
"use strict";
var React = require("react");
var ReactNative = require("react-native");
var View = ReactNative.View;
var Text = ReactNative.Text;
var StyleSheet = ReactNative.StyleSheet;
var Platform = ReactNative.Platform;
var Helper = require("./helper");
var styles = require("./styles");

var Section = function Section(props) {
  return React.createElement(View, { style: styles.section },
    React.createElement(Text, { style: styles.title }, props.title),
    React.createElement(Text, { style: styles.body }, props.body),
  );
};

function App() {
  return React.createElement(View, null,
    React.createElement(Section, { title: "A", body: Helper.format("a") }),
    React.createElement(Section, { title: "B", body: Helper.format("b") }),
    Platform.OS === "ios"
      ? React.createElement(Text, null, "iOS")
      : React.createElement(Text, null, "Other")
  );
}

module.exports = App;
"#;

fn bench(c: &mut Criterion) {
    let parsed = common::parse(FIXTURE);
    let mut group = c.benchmark_group("inline_requires");
    group.throughput(Throughput::Bytes(FIXTURE.len() as u64));
    group.bench_function("default", |b| {
        b.iter_batched(
            || parsed.clone(),
            |mut program| {
                inline_requires(&mut program, &Options::default());
                program
            },
            criterion::BatchSize::SmallInput,
        );
    });
    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
