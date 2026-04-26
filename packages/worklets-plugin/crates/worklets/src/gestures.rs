//! Recognisers for gesture-handler / layout-animation chains.
//!
//! The plugin needs to know whether an expression like
//! `Gesture.Pan().onUpdate(cb)` or
//! `FadeIn.duration(100).withCallback(cb)` is a gesture / layout-animation
//! construction so it can workletise the callbacks, and leave unrelated
//! member chains alone.
//!
//! The predicates are pure AST inspectors — no mutation, no allocations
//! beyond borrows.

use swc_core::ecma::ast::*;

use crate::hooks::{GESTURE_OBJECTS, LAYOUT_ANIMATIONS, LAYOUT_ANIM_CHAINABLE};

pub(crate) fn contains_gesture_obj(obj: &Expr) -> bool {
    if is_gesture_obj(obj) {
        return true;
    }
    if let Expr::Call(call) = obj {
        if let Callee::Expr(ce) = &call.callee {
            if let Expr::Member(me) = ce.as_ref() {
                return contains_gesture_obj(&me.obj);
            }
        }
    }
    false
}

pub(crate) fn is_gesture_obj(expr: &Expr) -> bool {
    if let Expr::Call(call) = expr {
        if let Callee::Expr(ce) = &call.callee {
            if let Expr::Member(me) = ce.as_ref() {
                if let Expr::Ident(obj) = me.obj.as_ref() {
                    if obj.sym.as_ref() == "Gesture" {
                        if let MemberProp::Ident(prop) = &me.prop {
                            return GESTURE_OBJECTS.contains(&prop.sym.as_ref());
                        }
                    }
                }
            }
        }
    }
    false
}

pub(crate) fn is_layout_anim_chain(expr: &Expr) -> bool {
    match expr {
        Expr::Ident(id) => LAYOUT_ANIMATIONS.contains(&id.sym.as_ref()),
        Expr::New(new_expr) => {
            if let Expr::Ident(id) = new_expr.callee.as_ref() {
                LAYOUT_ANIMATIONS.contains(&id.sym.as_ref())
            } else {
                false
            }
        }
        Expr::Call(call) => {
            if let Callee::Expr(ce) = &call.callee {
                if let Expr::Member(me) = ce.as_ref() {
                    if let MemberProp::Ident(prop) = &me.prop {
                        if LAYOUT_ANIM_CHAINABLE.contains(&prop.sym.as_ref()) {
                            return is_layout_anim_chain(&me.obj);
                        }
                    }
                }
            }
            false
        }
        _ => false,
    }
}
