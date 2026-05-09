#![allow(clippy::not_unsafe_ptr_arg_deref)]

use serde::Deserialize;
use swc_core::{
    ecma::ast::Program,
    plugin::{plugin_transform, proxies::TransformPluginProgramMetadata},
};

use crate::{constant_folding, experimental_imports, inline, inline_requires};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PostTransformPluginOptions {
    // Pass toggles. Each pass is opt-in; production (`src/swc.ts`) turns on
    // `experimental_imports` + `inline` + the conditional
    // `inline_requires` / `constant_folding`. Tests flip one at a time to
    // exercise a pass in isolation.
    experimental_imports: bool,
    inline: bool,
    inline_requires: bool,
    constant_folding: bool,

    // Inline-pass configuration.
    inline_platform: bool,
    platform: String,
    is_wrapped: bool,
    /// `__DEV__` substitution for the inline pass. `Some(b)` substitutes;
    /// `None` (default) leaves `__DEV__` as an Identifier so a downstream
    /// optimizer pass can handle it.
    dev: Option<bool>,
    /// `process.env.NODE_ENV` substitution for the inline pass. Same opt-in
    /// semantics as `dev`.
    node_env: Option<String>,

    // Inline-requires configuration.
    non_inlined_requires: Vec<String>,
    extra_inlineable_calls: Vec<String>,
    memoize_calls: bool,
    non_memoized_modules: Vec<String>,
}

#[plugin_transform]
pub fn process_transform(
    mut program: Program,
    metadata: TransformPluginProgramMetadata,
) -> Program {
    let options: PostTransformPluginOptions = metadata
        .get_transform_plugin_config()
        .and_then(|cfg| serde_json::from_str(&cfg).ok())
        .unwrap_or_default();

    // Order matches what production wires in via `src/swc.ts`: rewrite ESM to
    // `require(...)` first so `inline_requires` can recognise it, then inline
    // constants, then move requires to use sites, then fold constants.
    if options.experimental_imports {
        experimental_imports::rewrite_imports(&mut program);
    }

    if options.inline {
        inline::inline_plugin(
            &mut program,
            &inline::Options {
                inline_platform: options.inline_platform,
                is_wrapped: options.is_wrapped,
                require_name: "require".to_string(),
                platform: options.platform,
                dev: options.dev,
                node_env: options.node_env.clone(),
            },
        );
    }

    if options.inline_requires {
        // NOTE: `_$$_IMPORT_DEFAULT` / `_$$_IMPORT_ALL` deliberately stay
        // OUT of the inlineable list. If they were inlinable, `var X =
        // _$$_IMPORT_DEFAULT("m", "m")` would be folded away and any
        // `class Foo extends X` would become `class Foo extends
        // _$$_IMPORT_DEFAULT(...)`. SWC's downstream class transform
        // derives the IIFE parameter name from the super-class expression's
        // callee — yielding `function(_$$_IMPORT_DEFAULT) { … }`, which
        // SHADOWS the factory's own `_$$_IMPORT_DEFAULT` helper and turns
        // every subsequent helper call inside the class body into an
        // invocation of the passed-in super class (→ "Cannot call a class
        // as a function"). Keeping the helpers out of the inlineable list
        // leaves the module-level `var X = _$$_IMPORT_DEFAULT(…)` intact
        // and leaves `extends X` as a bare identifier, so the generated
        // IIFE parameter is safely named `_X`.
        let mut inlineable_calls = vec!["require".to_string()];
        inlineable_calls.extend(options.extra_inlineable_calls);
        inline_requires::inline_requires(
            &mut program,
            &inline_requires::Options {
                ignored_requires: options.non_inlined_requires,
                inlineable_calls,
                memoize_calls: options.memoize_calls,
                non_memoized_modules: options.non_memoized_modules,
            },
        );
    }

    if options.constant_folding {
        constant_folding::constant_folding(&mut program);
    }

    program
}
