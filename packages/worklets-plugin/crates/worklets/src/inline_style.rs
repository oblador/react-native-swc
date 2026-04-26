//! Inline-style warning for Reanimated v2+.
//!
//! When a worklet-bound style property reads `sharedValue.value` directly
//! the dev build should warn the user that the style won't update — this
//! module rewrites every `.value` access inside a style object into a
//! call that prints the warning at runtime before returning the original
//! value.
//!
//! All functions are `pub(crate)`; `plugin.rs` invokes `warn_obj` on
//! candidate style objects.

use swc_core::common::DUMMY_SP;
use swc_core::ecma::ast::*;

use crate::plugin::{mk_ident, prop_name_str, str_lit};

pub(crate) fn warn_obj(obj: &mut ObjectLit) {
    for prop in &mut obj.props {
        if let PropOrSpread::Prop(p) = prop {
            if let Prop::KeyValue(kv) = p.as_mut() {
                let key = prop_name_str(&kv.key);
                if key == Some("transform") {
                    warn_transform(&mut kv.value);
                } else {
                    warn_value(&mut kv.value);
                }
            }
        }
    }
}

fn warn_transform(v: &mut Box<Expr>) {
    if let Expr::Array(arr) = v.as_mut() {
        for ExprOrSpread { expr, .. } in arr.elems.iter_mut().flatten() {
            if let Expr::Object(o) = expr.as_mut() {
                warn_obj(o);
            }
        }
    }
}

fn warn_value(v: &mut Box<Expr>) {
    if let Expr::Member(me) = v.as_ref() {
        if !me.prop.is_computed() {
            if let MemberProp::Ident(prop) = &me.prop {
                if prop.sym.as_ref() == "value" {
                    let orig = v.as_ref().clone();
                    **v = inline_style_warning(orig);
                }
            }
        }
    }
}

/// Build an IIFE:
///
/// ```js
/// (() => {
///   console.warn(require("react-native-reanimated").getUseOfValueInStyleWarning());
///   return <orig>;
/// })()
/// ```
fn inline_style_warning(orig: Expr) -> Expr {
    Expr::Call(CallExpr {
        span: DUMMY_SP,
        ctxt: Default::default(),
        callee: Callee::Expr(Box::new(Expr::Paren(ParenExpr {
            span: DUMMY_SP,
            expr: Box::new(Expr::Arrow(ArrowExpr {
                span: DUMMY_SP,
                ctxt: Default::default(),
                params: vec![],
                body: Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
                    span: DUMMY_SP,
                    ctxt: Default::default(),
                    stmts: vec![
                        Stmt::Expr(ExprStmt {
                            span: DUMMY_SP,
                            expr: Box::new(Expr::Call(CallExpr {
                                span: DUMMY_SP,
                                ctxt: Default::default(),
                                callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                                    span: DUMMY_SP,
                                    obj: Box::new(mk_ident("console")),
                                    prop: MemberProp::Ident(IdentName::new(
                                        "warn".into(),
                                        DUMMY_SP,
                                    )),
                                }))),
                                args: vec![ExprOrSpread {
                                    spread: None,
                                    expr: Box::new(Expr::Call(CallExpr {
                                        span: DUMMY_SP,
                                        ctxt: Default::default(),
                                        callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                                            span: DUMMY_SP,
                                            obj: Box::new(Expr::Call(CallExpr {
                                                span: DUMMY_SP,
                                                ctxt: Default::default(),
                                                callee: Callee::Expr(Box::new(mk_ident("require"))),
                                                args: vec![ExprOrSpread {
                                                    spread: None,
                                                    expr: Box::new(str_lit(
                                                        "react-native-reanimated",
                                                    )),
                                                }],
                                                type_args: None,
                                            })),
                                            prop: MemberProp::Ident(IdentName::new(
                                                "getUseOfValueInStyleWarning".into(),
                                                DUMMY_SP,
                                            )),
                                        }))),
                                        args: vec![],
                                        type_args: None,
                                    })),
                                }],
                                type_args: None,
                            })),
                        }),
                        Stmt::Return(ReturnStmt {
                            span: DUMMY_SP,
                            arg: Some(Box::new(orig)),
                        }),
                    ],
                })),
                is_async: false,
                is_generator: false,
                type_params: None,
                return_type: None,
            })),
        }))),
        args: vec![],
        type_args: None,
    })
}
