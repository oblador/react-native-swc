pub mod constant_folding;
pub mod experimental_imports;
pub mod inline;
pub mod inline_requires;

#[cfg(target_arch = "wasm32")]
pub mod wasm_plugin;
