pub mod closure;
pub mod gestures;
pub mod globals;
pub mod hash;
pub mod hooks;
pub mod inline_style;
pub mod options;
pub mod plugin;

#[cfg(target_arch = "wasm32")]
pub mod wasm_plugin;

pub use options::PluginOptions;
pub use plugin::WorkletsPlugin;
