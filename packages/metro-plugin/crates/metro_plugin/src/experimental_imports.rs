//! Port of Metro's `importExportPlugin` import-side rewriting.
//!
//! Turns each ESM import declaration into a `var` binding that calls one of
//! two helpers (`_$$_IMPORT_DEFAULT` / `_$$_IMPORT_ALL`) with the specifier
//! string as both arguments. The worker's dependency-collection pass then
//! rewrites the first slot to `_dependencyMap[N]`, leaving the second as
//! the original specifier — matching Metro's Babel plugin output exactly.
//!
//! Shapes handled (matches Metro's importExportPlugin coverage):
//!
//! ```js
//! import x from "m";          // var x = _$$_IMPORT_DEFAULT("m", "m");
//! import * as ns from "m";    // var ns = _$$_IMPORT_ALL("m", "m");
//! import { a, b as c } from "m";
//! //                          // var a = require("m").a, c = require("m").b;
//! import x, { a } from "m";   // var x = _$$_IMPORT_DEFAULT("m", "m"),
//! //                          //     a = require("m").a;
//! import "m";                 // _$$_IMPORT_DEFAULT("m", "m");
//! ```
//!
//! Each named binding calls `require(…)` directly instead of sharing a
//! cache variable. The duplicate `require` calls are safe (Metro memoises
//! modules) and — more importantly — let the downstream
//! `inline_requires` pass recognise each `var X = require("m").X` as an
//! inline candidate. When inline-requires is on, the module-level
//! declarators are removed entirely and every use site gets its own
//! `require("m").X` call, so the module only evaluates on first use.
//!
//! Exports are left for SWC's built-in CJS pass, which already produces
//! the `exports.foo = …` / `Object.defineProperty(exports, "__esModule", …)`
//! shape Metro expects.

use swc_core::common::{Span, DUMMY_SP};
use swc_core::ecma::ast::*;

const IMPORT_DEFAULT: &str = "_$$_IMPORT_DEFAULT";
const IMPORT_ALL: &str = "_$$_IMPORT_ALL";

/// Rewrite every top-level `ImportDecl` in `program`.
pub fn rewrite_imports(program: &mut Program) {
    match program {
        Program::Module(m) => rewrite_module(m),
        // Scripts can't carry ESM imports; nothing to do.
        Program::Script(_) => {}
    }
}

fn rewrite_module(module: &mut Module) {
    // Emission layout:
    //
    //   "use strict"
    //   __esModule marker
    //   imports            ← side-effect imports fire first (matches ESM
    //                        hoisting; also ensures any subsequent eager
    //                        require in our star re-exports sees the side
    //                        effects already applied)
    //   named re-exports   ← lazy `Object.defineProperty(exports, …, { get })`
    //   star re-exports    ← eager IIFEs that enumerate the source module's
    //                        keys; skip anything already on exports so the
    //                        lazy named getters above win on conflicts
    //   body               ← everything else, in source order
    //
    // Reordering the re-exports away from SWC's CJS pass means we control
    // whether named re-exports' `defineProperty` precedes a `_export_star`
    // call. SWC would otherwise hoist `_export_star(...)` above the named
    // re-exports, and its non-configurable property definitions would then
    // block any later `defineProperty` with "property is not configurable".
    let mut imports: Vec<ModuleItem> = Vec::new();
    let mut named_reexports: Vec<ModuleItem> = Vec::new();
    let mut star_reexports: Vec<ModuleItem> = Vec::new();
    let mut body: Vec<ModuleItem> = Vec::with_capacity(module.body.len());
    let mut saw_esm = false;
    for item in module.body.drain(..) {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::Import(decl)) => {
                saw_esm = true;
                imports.push(rewrite(decl));
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named))
                if named.src.is_some() && !named.type_only =>
            {
                saw_esm = true;
                rewrite_reexport_named(named, &mut named_reexports);
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportAll(all)) if !all.type_only => {
                saw_esm = true;
                star_reexports.push(rewrite_reexport_all(all));
            }
            other => body.push(other),
        }
    }

    let mut out: Vec<ModuleItem> = Vec::with_capacity(
        imports.len() + named_reexports.len() + star_reexports.len() + body.len() + 2,
    );
    if saw_esm {
        if !has_leading_use_strict(&body) {
            out.push(use_strict_directive());
        }
        // Consumers resolve default imports via Metro's `_$$_IMPORT_DEFAULT`
        // helper, which checks `mod.__esModule` before unwrapping `.default`.
        // After we strip every `ImportDecl` / `ExportNamedDecl` / `ExportAll`
        // from the AST, SWC's CJS pass no longer recognises the file as a
        // module and skips the marker — so we emit it ourselves to keep the
        // interop contract intact.
        out.push(es_module_marker());
    }
    out.extend(imports);
    out.extend(named_reexports);
    out.extend(star_reexports);
    out.extend(body);

    module.body = out;
}

/// Emit `Object.defineProperty(exports, "__esModule", { value: true });` —
/// Metro / Babel's marker for "this module uses ESM semantics, so its
/// `default` export lives under `.default`". Without it, `_$$_IMPORT_DEFAULT`
/// returns the whole `exports` object on consumers, which breaks any
/// downstream `import X from "..."`.
fn es_module_marker() -> ModuleItem {
    let span = DUMMY_SP;
    let descriptor = Expr::Object(ObjectLit {
        span,
        props: vec![PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
            key: PropName::Ident(IdentName::new("value".into(), span)),
            value: Box::new(Expr::Lit(Lit::Bool(Bool { span, value: true }))),
        })))],
    });
    ModuleItem::Stmt(Stmt::Expr(ExprStmt {
        span,
        expr: Box::new(Expr::Call(CallExpr {
            span,
            ctxt: Default::default(),
            callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                span,
                obj: Box::new(Expr::Ident(ident("Object"))),
                prop: MemberProp::Ident(IdentName::new("defineProperty".into(), span)),
            }))),
            args: vec![
                ExprOrSpread {
                    spread: None,
                    expr: Box::new(Expr::Ident(ident("exports"))),
                },
                ExprOrSpread {
                    spread: None,
                    expr: Box::new(str_lit("__esModule")),
                },
                ExprOrSpread {
                    spread: None,
                    expr: Box::new(descriptor),
                },
            ],
            type_args: None,
        })),
    }))
}

/// Rewrite `export { orig as exported, … } from "m"` to a sequence of lazy
/// getter declarations:
///
/// ```js
/// Object.defineProperty(exports, "exported", {
///   enumerable: true,
///   get: function() { return require("m").orig; },
/// });
/// ```
///
/// No cache variable — `require("m")` fires on first access of the
/// re-exported property (Metro memoises modules, so repeat access is cheap).
/// Avoiding the cache means there's no eager `require("m")` at module init
/// and no ordering risk relative to SWC's `_export_star` emissions further
/// down the module body.
///
/// `export { default as X } from "m"` routes through `_$$_IMPORT_DEFAULT` so
/// CJS modules (whose `.default` isn't present) still resolve correctly.
fn rewrite_reexport_named(named: NamedExport, out: &mut Vec<ModuleItem>) {
    let specifier = named
        .src
        .as_ref()
        .unwrap()
        .value
        .to_string_lossy()
        .into_owned();
    let span = named.span;

    for spec in named.specifiers {
        let ExportSpecifier::Named(named_spec) = spec else {
            // Re-exports with `from` only use Named specifiers in practice.
            continue;
        };
        if named_spec.is_type_only {
            continue;
        }
        let orig_name = module_export_name_str(&named_spec.orig);
        let exported_name = named_spec
            .exported
            .as_ref()
            .map(module_export_name_str)
            .unwrap_or_else(|| orig_name.clone());

        let value_expr = if orig_name == "default" {
            helper_call(span, IMPORT_DEFAULT, &specifier)
        } else {
            Expr::Member(MemberExpr {
                span,
                obj: Box::new(require_call(span, &specifier)),
                prop: MemberProp::Ident(IdentName::new(orig_name.clone().into(), span)),
            })
        };

        out.push(define_property_getter(span, &exported_name, value_expr));
    }
}

/// Rewrite `export * from "m"` to:
///
/// ```js
/// (function() {
///   var _m = require("m");
///   Object.keys(_m).forEach(function(k) {
///     if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) {
///       Object.defineProperty(exports, k, {
///         enumerable: true,
///         get: function() { return _m[k]; },
///       });
///     }
///   });
/// })();
/// ```
///
/// Mirrors SWC's (and Metro's Babel) `_export_star` helper but emitted by
/// our own plugin so we can place it AFTER the named re-exports — ensuring
/// the named re-exports' lazy getters win on key conflicts.
fn rewrite_reexport_all(all: ExportAll) -> ModuleItem {
    let specifier = all.src.value.to_string_lossy().into_owned();
    let span = all.span;
    let cache = ident("_m");
    let k = ident("k");

    // body of `Object.keys(_m).forEach(function(k) { … })`
    let for_each_body = BlockStmt {
        span,
        ctxt: Default::default(),
        stmts: vec![Stmt::If(IfStmt {
            span,
            test: Box::new(Expr::Bin(BinExpr {
                span,
                op: BinaryOp::LogicalAnd,
                left: Box::new(Expr::Bin(BinExpr {
                    span,
                    op: BinaryOp::NotEqEq,
                    left: Box::new(Expr::Ident(k.clone())),
                    right: Box::new(str_lit("default")),
                })),
                right: Box::new(Expr::Unary(UnaryExpr {
                    span,
                    op: UnaryOp::Bang,
                    arg: Box::new(call_expr(
                        span,
                        Expr::Member(MemberExpr {
                            span,
                            obj: Box::new(Expr::Member(MemberExpr {
                                span,
                                obj: Box::new(Expr::Member(MemberExpr {
                                    span,
                                    obj: Box::new(Expr::Ident(ident("Object"))),
                                    prop: MemberProp::Ident(IdentName::new(
                                        "prototype".into(),
                                        span,
                                    )),
                                })),
                                prop: MemberProp::Ident(IdentName::new(
                                    "hasOwnProperty".into(),
                                    span,
                                )),
                            })),
                            prop: MemberProp::Ident(IdentName::new("call".into(), span)),
                        }),
                        vec![Expr::Ident(ident("exports")), Expr::Ident(k.clone())],
                    )),
                })),
            })),
            cons: Box::new(Stmt::Expr(ExprStmt {
                span,
                expr: Box::new(call_expr(
                    span,
                    Expr::Member(MemberExpr {
                        span,
                        obj: Box::new(Expr::Ident(ident("Object"))),
                        prop: MemberProp::Ident(IdentName::new("defineProperty".into(), span)),
                    }),
                    vec![
                        Expr::Ident(ident("exports")),
                        Expr::Ident(k.clone()),
                        Expr::Object(ObjectLit {
                            span,
                            props: vec![
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName::new("enumerable".into(), span)),
                                    value: Box::new(Expr::Lit(Lit::Bool(Bool {
                                        span,
                                        value: true,
                                    }))),
                                }))),
                                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                                    key: PropName::Ident(IdentName::new("get".into(), span)),
                                    value: Box::new(Expr::Fn(FnExpr {
                                        ident: None,
                                        function: Box::new(Function {
                                            params: vec![],
                                            decorators: vec![],
                                            span,
                                            ctxt: Default::default(),
                                            body: Some(BlockStmt {
                                                span,
                                                ctxt: Default::default(),
                                                stmts: vec![Stmt::Return(ReturnStmt {
                                                    span,
                                                    arg: Some(Box::new(Expr::Member(MemberExpr {
                                                        span,
                                                        obj: Box::new(Expr::Ident(cache.clone())),
                                                        prop: MemberProp::Computed(
                                                            ComputedPropName {
                                                                span,
                                                                expr: Box::new(Expr::Ident(
                                                                    k.clone(),
                                                                )),
                                                            },
                                                        ),
                                                    }))),
                                                })],
                                            }),
                                            is_generator: false,
                                            is_async: false,
                                            type_params: None,
                                            return_type: None,
                                        }),
                                    })),
                                }))),
                            ],
                        }),
                    ],
                )),
            })),
            alt: None,
        })],
    };

    let for_each_call = call_expr(
        span,
        Expr::Member(MemberExpr {
            span,
            obj: Box::new(call_expr(
                span,
                Expr::Member(MemberExpr {
                    span,
                    obj: Box::new(Expr::Ident(ident("Object"))),
                    prop: MemberProp::Ident(IdentName::new("keys".into(), span)),
                }),
                vec![Expr::Ident(cache.clone())],
            )),
            prop: MemberProp::Ident(IdentName::new("forEach".into(), span)),
        }),
        vec![Expr::Fn(FnExpr {
            ident: None,
            function: Box::new(Function {
                params: vec![Param {
                    span,
                    decorators: vec![],
                    pat: Pat::Ident(BindingIdent {
                        id: k.clone(),
                        type_ann: None,
                    }),
                }],
                decorators: vec![],
                span,
                ctxt: Default::default(),
                body: Some(for_each_body),
                is_generator: false,
                is_async: false,
                type_params: None,
                return_type: None,
            }),
        })],
    );

    let iife_body = BlockStmt {
        span,
        ctxt: Default::default(),
        stmts: vec![
            Stmt::Decl(Decl::Var(Box::new(VarDecl {
                span,
                kind: VarDeclKind::Var,
                declare: false,
                decls: vec![declarator(cache, require_call(span, &specifier))],
                ctxt: Default::default(),
            }))),
            Stmt::Expr(ExprStmt {
                span,
                expr: Box::new(for_each_call),
            }),
        ],
    };

    // `(function() { … })()`
    let iife = Expr::Call(CallExpr {
        span,
        ctxt: Default::default(),
        callee: Callee::Expr(Box::new(Expr::Fn(FnExpr {
            ident: None,
            function: Box::new(Function {
                params: vec![],
                decorators: vec![],
                span,
                ctxt: Default::default(),
                body: Some(iife_body),
                is_generator: false,
                is_async: false,
                type_params: None,
                return_type: None,
            }),
        }))),
        args: vec![],
        type_args: None,
    });

    ModuleItem::Stmt(Stmt::Expr(ExprStmt {
        span,
        expr: Box::new(iife),
    }))
}

fn call_expr(span: Span, callee: Expr, args: Vec<Expr>) -> Expr {
    Expr::Call(CallExpr {
        span,
        ctxt: Default::default(),
        callee: Callee::Expr(Box::new(callee)),
        args: args
            .into_iter()
            .map(|e| ExprOrSpread {
                spread: None,
                expr: Box::new(e),
            })
            .collect(),
        type_args: None,
    })
}

fn module_export_name_str(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::Ident(i) => i.sym.to_string(),
        ModuleExportName::Str(s) => s.value.to_string_lossy().into_owned(),
    }
}

/// Build `Object.defineProperty(exports, "<name>", { enumerable: true, get: function() { return <value>; } });`
fn define_property_getter(span: Span, export_name: &str, value: Expr) -> ModuleItem {
    let getter = Function {
        params: vec![],
        decorators: vec![],
        span,
        ctxt: Default::default(),
        body: Some(BlockStmt {
            span,
            ctxt: Default::default(),
            stmts: vec![Stmt::Return(ReturnStmt {
                span,
                arg: Some(Box::new(value)),
            })],
        }),
        is_generator: false,
        is_async: false,
        type_params: None,
        return_type: None,
    };

    let descriptor = Expr::Object(ObjectLit {
        span,
        props: vec![
            PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                key: PropName::Ident(IdentName::new("enumerable".into(), span)),
                value: Box::new(Expr::Lit(Lit::Bool(Bool { span, value: true }))),
            }))),
            PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                key: PropName::Ident(IdentName::new("get".into(), span)),
                value: Box::new(Expr::Fn(FnExpr {
                    ident: None,
                    function: Box::new(getter),
                })),
            }))),
        ],
    });

    let call = Expr::Call(CallExpr {
        span,
        ctxt: Default::default(),
        callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
            span,
            obj: Box::new(Expr::Ident(ident("Object"))),
            prop: MemberProp::Ident(IdentName::new("defineProperty".into(), span)),
        }))),
        args: vec![
            ExprOrSpread {
                spread: None,
                expr: Box::new(Expr::Ident(ident("exports"))),
            },
            ExprOrSpread {
                spread: None,
                expr: Box::new(str_lit(export_name)),
            },
            ExprOrSpread {
                spread: None,
                expr: Box::new(descriptor),
            },
        ],
        type_args: None,
    });

    ModuleItem::Stmt(Stmt::Expr(ExprStmt {
        span,
        expr: Box::new(call),
    }))
}

fn has_leading_use_strict(items: &[ModuleItem]) -> bool {
    for item in items {
        if let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = item {
            if let Expr::Lit(Lit::Str(s)) = expr.as_ref() {
                if s.value.as_str() == Some("use strict") {
                    return true;
                }
                // Other directive literals don't block ours, but we also
                // don't want to scan past non-directive statements.
            } else {
                return false;
            }
        } else {
            return false;
        }
    }
    false
}

fn use_strict_directive() -> ModuleItem {
    ModuleItem::Stmt(Stmt::Expr(ExprStmt {
        span: DUMMY_SP,
        expr: Box::new(Expr::Lit(Lit::Str(Str {
            span: DUMMY_SP,
            value: "use strict".into(),
            raw: None,
        }))),
    }))
}

fn rewrite(decl: ImportDecl) -> ModuleItem {
    let specifier = decl.src.value.to_string_lossy().into_owned();
    let span = decl.span;

    // Side-effect import: `import "m";`
    if decl.specifiers.is_empty() {
        return ModuleItem::Stmt(Stmt::Expr(ExprStmt {
            span,
            expr: Box::new(helper_call(span, IMPORT_DEFAULT, &specifier)),
        }));
    }

    // Partition specifiers — `import x, * as ns from "m"` is illegal, so the
    // only interesting combinations are default-only, namespace-only,
    // named-only, and default + named.
    let mut default: Option<Ident> = None;
    let mut namespace: Option<Ident> = None;
    let mut named: Vec<(String, Ident)> = Vec::new();

    for spec in decl.specifiers {
        match spec {
            ImportSpecifier::Default(d) => default = Some(d.local),
            ImportSpecifier::Namespace(n) => namespace = Some(n.local),
            ImportSpecifier::Named(n) => {
                let imported = match n.imported {
                    Some(ModuleExportName::Ident(i)) => i.sym.to_string(),
                    Some(ModuleExportName::Str(s)) => s.value.to_string_lossy().into_owned(),
                    None => n.local.sym.to_string(),
                };
                named.push((imported, n.local));
            }
        }
    }

    if let Some(ns) = namespace {
        return var_decl(
            span,
            vec![declarator(ns, helper_call(span, IMPORT_ALL, &specifier))],
        );
    }

    if named.is_empty() {
        let local = default.expect("import decl with no specifiers handled above");
        return var_decl(
            span,
            vec![declarator(
                local,
                helper_call(span, IMPORT_DEFAULT, &specifier),
            )],
        );
    }

    // Named (+ optional default): emit one declarator per binding, each
    // calling `require(…)` (or the default helper) directly, so the
    // `inline-requires` pass downstream can recognise each as an inline
    // candidate and move the call to the use site. Metro's module cache
    // dedupes the repeated `require` lookups, so the duplicate calls are
    // cheap and, when inline-requires is on, the module-level declarators
    // are removed anyway.
    let mut decls: Vec<VarDeclarator> = Vec::new();

    if let Some(local) = default {
        decls.push(declarator(
            local,
            helper_call(span, IMPORT_DEFAULT, &specifier),
        ));
    }

    for (imported, local) in named {
        decls.push(declarator(
            local,
            member(require_call(span, &specifier), &imported),
        ));
    }

    var_decl(span, decls)
}

// ---------------------------------------------------------------------------
// AST builders
// ---------------------------------------------------------------------------

fn var_decl(span: Span, decls: Vec<VarDeclarator>) -> ModuleItem {
    ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
        span,
        kind: VarDeclKind::Var,
        declare: false,
        decls,
        ctxt: Default::default(),
    }))))
}

fn declarator(local: Ident, init: Expr) -> VarDeclarator {
    VarDeclarator {
        span: DUMMY_SP,
        name: Pat::Ident(BindingIdent {
            id: local,
            type_ann: None,
        }),
        init: Some(Box::new(init)),
        definite: false,
    }
}

/// `_$$_IMPORT_DEFAULT("m", "m")` / `_$$_IMPORT_ALL("m", "m")`. Both slots
/// carry the specifier string; the worker's dep pass rewrites the first to
/// `_dependencyMap[N]`.
fn helper_call(span: Span, helper: &str, specifier: &str) -> Expr {
    Expr::Call(CallExpr {
        span,
        ctxt: Default::default(),
        callee: Callee::Expr(Box::new(Expr::Ident(ident(helper)))),
        args: vec![
            ExprOrSpread {
                spread: None,
                expr: Box::new(str_lit(specifier)),
            },
            ExprOrSpread {
                spread: None,
                expr: Box::new(str_lit(specifier)),
            },
        ],
        type_args: None,
    })
}

/// `require("m")` — the worker's dependency-collection pass rewrites this
/// to `_dependencyMap[N]` later.
fn require_call(span: Span, specifier: &str) -> Expr {
    Expr::Call(CallExpr {
        span,
        ctxt: Default::default(),
        callee: Callee::Expr(Box::new(Expr::Ident(ident("require")))),
        args: vec![ExprOrSpread {
            spread: None,
            expr: Box::new(str_lit(specifier)),
        }],
        type_args: None,
    })
}

fn member(obj: Expr, key: &str) -> Expr {
    Expr::Member(MemberExpr {
        span: DUMMY_SP,
        obj: Box::new(obj),
        prop: MemberProp::Ident(IdentName::new(key.into(), DUMMY_SP)),
    })
}

fn ident(name: &str) -> Ident {
    Ident::new(name.into(), DUMMY_SP, Default::default())
}

fn str_lit(s: &str) -> Expr {
    Expr::Lit(Lit::Str(Str {
        span: DUMMY_SP,
        value: s.into(),
        raw: None,
    }))
}
