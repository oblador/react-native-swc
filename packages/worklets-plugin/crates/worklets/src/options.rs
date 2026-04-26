use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PluginOptions {
    /// Enables Bundle Mode.
    pub bundle_mode: bool,

    /// Suppresses inline shared values warning.
    pub disable_inline_styles_warning: bool,

    /// Disables source map generation for worklets.
    pub disable_source_maps: bool,

    /// Disables Worklet Classes support.
    pub disable_worklet_classes: bool,

    /// List of extra identifiers treated as globals (not captured in closures).
    pub globals: Vec<String>,

    /// Uses relative source location in source maps.
    pub relative_source_location: bool,

    /// Makes no global identifiers implicitly captured.
    pub strict_global: bool,

    /// Overrides the version string emitted as `__pluginVersion`.
    /// When unset, the crate's own package version is used.
    pub plugin_version: Option<String>,
}
