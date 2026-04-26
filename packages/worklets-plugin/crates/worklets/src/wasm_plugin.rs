#![allow(clippy::not_unsafe_ptr_arg_deref)]

use swc_core::{
    ecma::{ast::Program, visit::VisitMutWith},
    plugin::{
        metadata::TransformPluginMetadataContextKind, plugin_transform,
        proxies::TransformPluginProgramMetadata,
    },
};

use crate::{PluginOptions, WorkletsPlugin};

#[plugin_transform]
pub fn process_transform(
    mut program: Program,
    metadata: TransformPluginProgramMetadata,
) -> Program {
    let options = metadata
        .get_transform_plugin_config()
        .and_then(|cfg| serde_json::from_str::<PluginOptions>(&cfg).ok())
        .unwrap_or_default();

    let filename = metadata
        .get_context(&TransformPluginMetadataContextKind::Filename)
        .unwrap_or_default();

    // SWC populates `Env` from the host process's `NODE_ENV`. Match it
    // against the same pattern Reanimated's upstream Babel plugin uses
    // (`isRelease()` in `plugin/src/utils.ts`) so values like
    // `production`, `release`, or `staging` — not just an exact
    // `"production"` — activate release-mode output.
    let env = metadata
        .get_context(&TransformPluginMetadataContextKind::Env)
        .unwrap_or_default();
    let is_release = is_release_env(&env);

    let mut plugin = WorkletsPlugin::new(options, filename, is_release);
    plugin.file_bindings = crate::closure::collect_file_bindings(&program);
    program.visit_mut_with(&mut plugin);
    program
}

/// Case-insensitive substring match for the Reanimated Babel plugin's release
/// regex: `/(prod|release|stag[ei])/i`.
fn is_release_env(env: &str) -> bool {
    let lower = env.to_ascii_lowercase();
    lower.contains("prod")
        || lower.contains("release")
        || lower.contains("stage")
        || lower.contains("stagi")
}

#[cfg(test)]
mod tests {
    use super::is_release_env;

    #[test]
    fn matches_release_aliases() {
        for v in ["production", "PRODUCTION", "release", "Stage", "staging"] {
            assert!(is_release_env(v), "expected release for {v}");
        }
    }

    #[test]
    fn rejects_non_release() {
        for v in ["", "development", "test", "local"] {
            assert!(!is_release_env(v), "expected non-release for {v}");
        }
    }
}
