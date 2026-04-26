use std::path::{Path, PathBuf};

use rustc_hash::FxHashSet;
use swc_core::atoms::Atom;
use swc_core::common::source_map::DefaultSourceMapGenConfig;
use swc_core::common::{sync::Lrc, BytePos, LineCol, SourceMap, DUMMY_SP};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as EmitConfig, Emitter};
use swc_core::ecma::visit::{Visit, VisitMut, VisitMutWith, VisitWith};

use crate::closure::{
    collect_closure_vars, collect_closure_vars_arrow, collect_pat_bindings, ClosureCtx,
    DeclCollector,
};
use crate::gestures::{contains_gesture_obj, is_layout_anim_chain};
use crate::globals::DEFAULT_GLOBALS;
use crate::hash::worklet_hash;
use crate::hooks::{
    function_hooks, is_object_hook, GESTURE_BUILDER_METHODS, LAYOUT_ANIM_CALLBACKS,
};
use crate::inline_style::warn_obj;
use crate::options::PluginOptions;
use indexmap::IndexSet;

const WORKLET_DIRECTIVE: &str = "worklet";
/// Fallback value stamped into `__pluginVersion` when the caller didn't
/// pass one. Upstream Reanimated expects consumers to supply the
/// `react-native-worklets` package version; when omitted we emit
/// `"unknown"` rather than the crate's own version so the bundle never
/// silently disagrees with the runtime.
const UNKNOWN_VERSION: &str = "unknown";
const CONTEXT_OBJECT_MARKER: &str = "__workletContextObject";
const CONTEXT_OBJECT_FACTORY: &str = "__workletContextObjectFactory";
const WORKLET_CLASS_MARKER: &str = "__workletClass";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

pub struct WorkletsPlugin {
    pub options: PluginOptions,
    pub filename: String,
    pub worklet_number: u32,
    pub is_release: bool,
    pub globals: FxHashSet<Atom>,
    pub file_bindings: FxHashSet<Atom>,
    pub source_map: Option<Lrc<SourceMap>>,
    pending_prepends: Vec<Stmt>,
}

impl WorkletsPlugin {
    pub fn new(options: PluginOptions, filename: impl Into<String>, is_release: bool) -> Self {
        let mut globals: FxHashSet<Atom> = DEFAULT_GLOBALS.iter().map(|s| Atom::from(*s)).collect();
        for g in &options.globals {
            globals.insert(Atom::from(g.as_str()));
        }
        Self {
            options,
            filename: filename.into(),
            worklet_number: 1,
            is_release,
            globals,
            file_bindings: FxHashSet::default(),
            source_map: None,
            pending_prepends: vec![],
        }
    }

    /// Attach the source map so worklet factories can emit real `sourceMap`
    /// entries mapping generated worklet code back to the original source.
    pub fn with_source_map(mut self, cm: Lrc<SourceMap>) -> Self {
        self.source_map = Some(cm);
        self
    }

    fn closure_ctx(&self) -> ClosureCtx<'_> {
        ClosureCtx {
            globals: &self.globals,
            file_bindings: &self.file_bindings,
            strict_global: self.options.strict_global,
        }
    }

    fn plugin_version(&self) -> &str {
        self.options
            .plugin_version
            .as_deref()
            .unwrap_or(UNKNOWN_VERSION)
    }

    /// Path to emit into `init_data.location` (and as the `sources[0]` entry
    /// of emitted source maps). Honors `relative_source_location` by stripping
    /// the current working directory prefix when possible.
    fn location_path(&self) -> String {
        if self.filename.is_empty() {
            return String::new();
        }
        if !self.options.relative_source_location {
            return self.filename.clone();
        }
        let Ok(cwd) = std::env::current_dir() else {
            return self.filename.clone();
        };
        let abs = PathBuf::from(&self.filename);
        abs.strip_prefix(&cwd)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| self.filename.clone())
    }

    fn source_name(&self) -> String {
        if self.filename.is_empty() {
            return "unknownFile".to_string();
        }
        let base = Path::new(&self.filename)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknownFile")
            .to_string();
        let parts: Vec<&str> = self.filename.split('/').collect();
        if let Some(idx) = parts.iter().position(|&p| p == "node_modules") {
            if let Some(lib) = parts.get(idx + 1) {
                return format!("{}_{}", lib, base);
            }
        }
        base
    }

    fn next_name(&mut self, func_name: Option<&str>) -> (String, String) {
        let source = self.source_name();
        let suffix = format!("{}{}", source, self.worklet_number);
        self.worklet_number += 1;
        let worklet_name = func_name
            .filter(|n| !n.is_empty())
            .map(|n| sanitize_ident(&format!("{}_{}", n, suffix)))
            .unwrap_or_else(|| sanitize_ident(&suffix));
        let react_name = func_name
            .filter(|n| !n.is_empty())
            .map(sanitize_ident)
            .unwrap_or_else(|| sanitize_ident(&suffix));
        (worklet_name, react_name)
    }

    // -------------------------------------------------------------------------
    // Directive helpers
    // -------------------------------------------------------------------------

    fn has_worklet_directive(stmts: &[Stmt]) -> bool {
        stmts
            .iter()
            .any(|s| str_stmt_value(s) == Some(WORKLET_DIRECTIVE))
    }

    fn strip_worklet_directives(stmts: &mut Vec<Stmt>) {
        stmts.retain(|s| match str_stmt_value(s) {
            Some(v) => !matches!(
                v,
                WORKLET_DIRECTIVE | "no-worklet-closure" | "limit-init-data-hoisting"
            ),
            None => true,
        });
    }

    fn is_already_workletized(stmts: &[Stmt]) -> bool {
        stmts.iter().any(|s| {
            if let Stmt::Expr(ExprStmt { expr, .. }) = s {
                if let Expr::Assign(AssignExpr {
                    left: AssignTarget::Simple(SimpleAssignTarget::Member(me)),
                    ..
                }) = expr.as_ref()
                {
                    if let MemberProp::Ident(id) = &me.prop {
                        return id.sym.as_ref() == "__workletHash";
                    }
                }
            }
            false
        })
    }

    // -------------------------------------------------------------------------
    // Core: build factory call from params + body
    // -------------------------------------------------------------------------

    fn make_factory_call(
        &mut self,
        func_name: Option<&str>,
        params: Vec<Param>,
        mut body: BlockStmt,
        mut closure_vars: Vec<Ident>,
        is_generator: bool,
        is_async: bool,
    ) -> Expr {
        let (worklet_name, react_name) = self.next_name(func_name);
        // Recursion support: if the worklet is named and references its own
        // name in its body, rename those references to the worklet's internal
        // name and prepend a `const <worklet_name> = this._recur;` binding so
        // the renamed calls resolve against the running worklet instance at
        // UI-thread dispatch time.
        if let Some(orig) = func_name.filter(|n| !n.is_empty()) {
            if orig != worklet_name {
                let renamed = rename_free_refs(&mut body, orig, &worklet_name);
                if renamed {
                    body.stmts.insert(0, make_recur_decl(&worklet_name));
                    // The closure-collection pass ran before the rename and
                    // captured `orig` as a free variable; drop it now that no
                    // references remain — recursion is handled via `_recur`.
                    closure_vars.retain(|v| v.sym.as_ref() != orig);
                }
            }
        }
        let location_str = if self.is_release {
            String::new()
        } else {
            self.location_path()
        };
        let (code_str, real_source_map) = build_worklet_code_and_map(
            &worklet_name,
            &params,
            &body,
            &closure_vars,
            is_generator,
            is_async,
            self.source_map.as_ref(),
            &location_str,
        );
        let hash = worklet_hash(&code_str);
        let init_id = format!("_worklet_{}_init_data", hash);
        let source_map_str = if self.is_release || self.options.disable_source_maps {
            None
        } else {
            real_source_map
        };

        // Schedule init_data prepend — always emitted; the native Reanimated
        // runtime needs it to hydrate the worklet on iOS/Android.
        self.pending_prepends.push(make_init_data_decl(
            &init_id,
            &code_str,
            &location_str,
            source_map_str.as_deref(),
        ));

        // Factory body statements
        let mut stmts: Vec<Stmt> = vec![];
        if !self.is_release {
            stmts.push(make_stack_details_decl());
        }
        stmts.push(make_const_fn(
            &react_name,
            params,
            body,
            is_generator,
            is_async,
        ));
        stmts.push(make_assign(
            &react_name,
            "__closure",
            Expr::Object(ObjectLit {
                span: DUMMY_SP,
                // These shorthand entries reference the destructured factory
                // params introduced by `factory_param`, which are local to
                // this IIFE — so emitting them with fresh (empty-ctxt)
                // idents is correct and must NOT carry the original ctxt.
                props: closure_vars
                    .iter()
                    .map(|v| shorthand(v.sym.as_ref()))
                    .collect(),
            }),
        ));
        stmts.push(make_assign(
            &react_name,
            "__workletHash",
            num_lit(hash as f64),
        ));
        if !self.is_release {
            stmts.push(make_assign(
                &react_name,
                "__pluginVersion",
                str_lit(self.plugin_version()),
            ));
        }
        stmts.push(make_assign(&react_name, "__initData", mk_ident(&init_id)));
        if !self.is_release {
            stmts.push(make_assign(&react_name, "__stackDetails", mk_ident("_e")));
        }
        stmts.push(Stmt::Return(ReturnStmt {
            span: DUMMY_SP,
            arg: Some(Box::new(mk_ident(&react_name))),
        }));

        let factory_fn = FnExpr {
            ident: Some(make_ident(&format!("{}Factory", worklet_name))),
            function: Box::new(Function {
                params: vec![factory_param(&closure_vars, &init_id)],
                decorators: vec![],
                span: DUMMY_SP,
                ctxt: Default::default(),
                body: Some(BlockStmt {
                    span: DUMMY_SP,
                    stmts,
                    ctxt: Default::default(),
                }),
                is_generator: false,
                is_async: false,
                type_params: None,
                return_type: None,
            }),
        };

        let call_obj = factory_call_obj(&closure_vars, &init_id);

        Expr::Call(CallExpr {
            span: DUMMY_SP,
            ctxt: Default::default(),
            callee: Callee::Expr(Box::new(Expr::Paren(ParenExpr {
                span: DUMMY_SP,
                expr: Box::new(Expr::Fn(factory_fn)),
            }))),
            args: vec![ExprOrSpread {
                spread: None,
                expr: Box::new(call_obj),
            }],
            type_args: None,
        })
    }

    // -------------------------------------------------------------------------
    // Try workletize (directive required)
    // -------------------------------------------------------------------------

    fn try_workletize_fn(&mut self, name_hint: Option<&str>, fn_expr: &mut FnExpr) -> Option<Expr> {
        let body = fn_expr.function.body.as_mut()?;
        if Self::is_already_workletized(&body.stmts) || !Self::has_worklet_directive(&body.stmts) {
            return None;
        }
        Self::strip_worklet_directives(&mut body.stmts);
        let params = fn_expr.function.params.clone();
        let body_c = body.clone();
        let cv = collect_closure_vars(&params, &body_c, &self.closure_ctx());
        let name = name_hint
            .map(String::from)
            .or_else(|| fn_expr.ident.as_ref().map(|i| i.sym.to_string()));
        Some(self.make_factory_call(
            name.as_deref(),
            params,
            body_c,
            cv,
            fn_expr.function.is_generator,
            fn_expr.function.is_async,
        ))
    }

    fn try_workletize_arrow(
        &mut self,
        name_hint: Option<&str>,
        arrow: &mut ArrowExpr,
    ) -> Option<Expr> {
        let body = match arrow.body.as_mut() {
            BlockStmtOrExpr::BlockStmt(b) => b,
            _ => return None,
        };
        if Self::is_already_workletized(&body.stmts) || !Self::has_worklet_directive(&body.stmts) {
            return None;
        }
        Self::strip_worklet_directives(&mut body.stmts);
        let pats = arrow.params.clone();
        let params: Vec<Param> = pats
            .iter()
            .map(|p| Param {
                span: DUMMY_SP,
                decorators: vec![],
                pat: p.clone(),
            })
            .collect();
        let body_c = body.clone();
        let cv = collect_closure_vars_arrow(
            &pats,
            &BlockStmtOrExpr::BlockStmt(body_c.clone()),
            &self.closure_ctx(),
        );
        Some(self.make_factory_call(name_hint, params, body_c, cv, false, arrow.is_async))
    }

    // -------------------------------------------------------------------------
    // Force workletize (no directive required – for auto-workletization)
    // -------------------------------------------------------------------------

    fn force_workletize(&mut self, expr: &mut Expr, accept_fn: bool, accept_obj: bool) -> bool {
        match expr {
            Expr::Fn(fn_expr) if accept_fn => {
                let body = match fn_expr.function.body.as_mut() {
                    Some(b) => b,
                    None => return false,
                };
                if Self::is_already_workletized(&body.stmts) {
                    return false;
                }
                Self::strip_worklet_directives(&mut body.stmts);
                let params = fn_expr.function.params.clone();
                let body_c = body.clone();
                let cv = collect_closure_vars(&params, &body_c, &self.closure_ctx());
                let name = fn_expr.ident.as_ref().map(|i| i.sym.to_string());
                let new = self.make_factory_call(
                    name.as_deref(),
                    params,
                    body_c,
                    cv,
                    fn_expr.function.is_generator,
                    fn_expr.function.is_async,
                );
                *expr = new;
                true
            }
            Expr::Arrow(arrow) if accept_fn => {
                ensure_block_body(arrow);
                let body = match arrow.body.as_mut() {
                    BlockStmtOrExpr::BlockStmt(b) => b,
                    _ => return false,
                };
                if Self::is_already_workletized(&body.stmts) {
                    return false;
                }
                Self::strip_worklet_directives(&mut body.stmts);
                let pats = arrow.params.clone();
                let params: Vec<Param> = pats
                    .iter()
                    .map(|p| Param {
                        span: DUMMY_SP,
                        decorators: vec![],
                        pat: p.clone(),
                    })
                    .collect();
                let body_c = body.clone();
                let cv = collect_closure_vars_arrow(
                    &pats,
                    &BlockStmtOrExpr::BlockStmt(body_c.clone()),
                    &self.closure_ctx(),
                );
                let new = self.make_factory_call(None, params, body_c, cv, false, arrow.is_async);
                *expr = new;
                true
            }
            Expr::Object(obj) if accept_obj => self.force_workletize_obj(obj),
            // See through `(a, b, ...lastExpr)` — only the trailing expression
            // is the runtime value of the sequence, so only that one is
            // workletized (earlier expressions stay as-is, preserving their
            // side effects). Example: `useAnimatedStyle((setup(), () => ...))`.
            Expr::Seq(seq) => {
                if let Some(last) = seq.exprs.last_mut() {
                    self.force_workletize(last, accept_fn, accept_obj)
                } else {
                    false
                }
            }
            // A parenthesized expression is transparent to workletization —
            // parentheses don't change the runtime value. SWC preserves them
            // in the AST, so we explicitly unwrap.
            Expr::Paren(paren) => self.force_workletize(&mut paren.expr, accept_fn, accept_obj),
            _ => false,
        }
    }

    /// Workletize a `function foo() { 'worklet'; ... }` declaration into a
    /// `const foo = factory;` variable declaration, if it has the directive.
    fn try_workletize_fn_decl(&mut self, fn_decl: &mut FnDecl) -> Option<VarDecl> {
        fn_decl.function.visit_mut_with(self);
        let body = fn_decl.function.body.as_mut()?;
        if Self::is_already_workletized(&body.stmts) || !Self::has_worklet_directive(&body.stmts) {
            return None;
        }
        Self::strip_worklet_directives(&mut body.stmts);
        let name = fn_decl.ident.sym.to_string();
        let params = fn_decl.function.params.clone();
        let body_c = body.clone();
        let cv = collect_closure_vars(&params, &body_c, &self.closure_ctx());
        let fc = self.make_factory_call(
            Some(&name),
            params,
            body_c,
            cv,
            fn_decl.function.is_generator,
            fn_decl.function.is_async,
        );
        // Preserve the original function's `Ident` (and its `SyntaxContext`)
        // on the replacement `const` binding. Subsequent SWC passes (ESM→CJS,
        // hygiene renaming) resolve references to this function by matching
        // the source ident's ctxt; emitting a fresh empty-ctxt ident here
        // would orphan every `fn_name` reference elsewhere in the module.
        Some(VarDecl {
            span: DUMMY_SP,
            ctxt: Default::default(),
            kind: VarDeclKind::Const,
            declare: false,
            decls: vec![VarDeclarator {
                span: DUMMY_SP,
                name: Pat::Ident(BindingIdent {
                    id: fn_decl.ident.clone(),
                    type_ann: None,
                }),
                init: Some(Box::new(fc)),
                definite: false,
            }],
        })
    }

    /// Walk class members and workletize any whose body opens with a
    /// `'worklet'` directive.
    ///
    /// Regular instance/static methods are rewritten as class fields whose
    /// initializer is a worklet-factory call — this is the cleanest shape
    /// because a class field can directly hold an expression value, whereas
    /// a `method() { ... }` slot cannot be replaced by one.
    ///
    /// Getters, setters and constructors keep their syntactic shape but have
    /// the `'worklet'` directive stripped and their body registered with the
    /// factory machinery as a side effect (so `init_data` is still emitted
    /// at module scope). This is a minimal-viable semantic: the factory call
    /// isn't wired up into the accessor body, so workletized getters/setters
    /// won't actually run on the UI thread at call time. Use a class field
    /// with a `'worklet'` arrow function if you need that behavior.
    fn workletize_class_body(&mut self, class: &mut Class) {
        // `__workletClass` marker: a class-level opt-in that workletizes every
        // method without requiring a per-method directive. Marker presence
        // (regardless of value) is what matters — upstream reanimated uses the
        // same semantic. Gated behind `disable_worklet_classes`.
        let marker_idx = class.body.iter().position(is_worklet_class_marker);
        if let Some(idx) = marker_idx {
            if self.options.disable_worklet_classes {
                // Leave the class untouched (including the marker, matching
                // what Babel does when its class-worklet transform is off).
                return;
            }
            class.body.remove(idx);
            for m in &mut class.body {
                match m {
                    ClassMember::Method(method) => {
                        if let Some(body) = method.function.body.as_mut() {
                            push_dir(body);
                        }
                    }
                    ClassMember::Constructor(c) => {
                        if let Some(body) = c.body.as_mut() {
                            push_dir(body);
                        }
                    }
                    ClassMember::ClassProp(p) => {
                        if let Some(value) = p.value.as_mut() {
                            add_worklet_dir_expr(value);
                        }
                    }
                    _ => {}
                }
            }
        }
        let members = std::mem::take(&mut class.body);
        let mut new_members = Vec::with_capacity(members.len());
        for m in members {
            match m {
                ClassMember::Method(method) => {
                    new_members.push(self.workletize_class_method(method));
                }
                ClassMember::Constructor(ctor) => {
                    new_members.push(self.workletize_class_constructor(ctor));
                }
                other => new_members.push(other),
            }
        }
        class.body = new_members;
    }

    fn workletize_class_method(&mut self, mut method: ClassMethod) -> ClassMember {
        let body_has_directive = method.function.body.as_ref().is_some_and(|b| {
            !Self::is_already_workletized(&b.stmts) && Self::has_worklet_directive(&b.stmts)
        });
        if !body_has_directive {
            return ClassMember::Method(method);
        }
        // Strip the directive before cloning the body for the factory.
        if let Some(body) = method.function.body.as_mut() {
            Self::strip_worklet_directives(&mut body.stmts);
        }
        let Some(body) = method.function.body.clone() else {
            return ClassMember::Method(method);
        };
        let params = method.function.params.clone();
        let cv = collect_closure_vars(&params, &body, &self.closure_ctx());
        let name = prop_name_str(&method.key);
        let factory_call = self.make_factory_call(
            name,
            params,
            body,
            cv,
            method.function.is_generator,
            method.function.is_async,
        );

        match method.kind {
            MethodKind::Method => ClassMember::ClassProp(ClassProp {
                span: method.span,
                key: method.key,
                value: Some(Box::new(factory_call)),
                type_ann: None,
                is_static: method.is_static,
                decorators: vec![],
                accessibility: method.accessibility,
                is_abstract: method.is_abstract,
                is_optional: method.is_optional,
                is_override: method.is_override,
                readonly: false,
                declare: false,
                definite: false,
            }),
            MethodKind::Getter | MethodKind::Setter => {
                // The factory call was emitted purely for its side effect
                // (init_data pushed to pending_prepends). The accessor itself
                // is left alone — see the function-level doc for the
                // implications.
                let _ = factory_call;
                ClassMember::Method(method)
            }
        }
    }

    fn workletize_class_constructor(&mut self, mut ctor: Constructor) -> ClassMember {
        let body_has_directive = ctor.body.as_ref().is_some_and(|b| {
            !Self::is_already_workletized(&b.stmts) && Self::has_worklet_directive(&b.stmts)
        });
        if !body_has_directive {
            return ClassMember::Constructor(ctor);
        }
        if let Some(body) = ctor.body.as_mut() {
            Self::strip_worklet_directives(&mut body.stmts);
        }
        let Some(body) = ctor.body.clone() else {
            return ClassMember::Constructor(ctor);
        };
        // TypeScript parameter properties (`constructor(public x: T)`) are
        // not exposed as regular identifiers in the body's free-variable
        // analysis, so filter them out here.
        let params: Vec<Param> = ctor
            .params
            .iter()
            .filter_map(|p| match p {
                ParamOrTsParamProp::Param(p) => Some(p.clone()),
                ParamOrTsParamProp::TsParamProp(_) => None,
            })
            .collect();
        let cv = collect_closure_vars(&params, &body, &self.closure_ctx());
        // Fire-and-forget: the returned Expr is dropped; the init_data
        // statement was registered in pending_prepends.
        let _ = self.make_factory_call(Some("constructor"), params, body, cv, false, false);
        ClassMember::Constructor(ctor)
    }

    /// Expand an object literal marked with `__workletContextObject: true`
    /// into a plain object plus a `__workletContextObjectFactory` method that
    /// returns a worklet clone of the same object. A later pass
    /// (`workletize_directive_methods`) will rewrite the factory method into a
    /// factory call, so each method of the context object becomes available
    /// on the UI thread.
    ///
    /// Input:
    ///   { __workletContextObject: true, x: 1, m() { ... } }
    /// Output (before method workletization runs):
    ///   { x: 1, m() { ... }, __workletContextObjectFactory() { 'worklet'; return { x: 1, m() { ... } }; } }
    fn process_context_object(&mut self, obj: &mut ObjectLit) -> bool {
        let Some(marker_idx) = obj.props.iter().position(is_context_object_marker) else {
            return false;
        };
        obj.props.remove(marker_idx);
        // Clone the (now marker-less) object for the factory's return value.
        // The factory itself is appended *after* the clone, so the returned
        // object does not recursively contain a factory property.
        let cloned = obj.clone();
        let factory_body = BlockStmt {
            span: DUMMY_SP,
            stmts: vec![
                Stmt::Expr(ExprStmt {
                    span: DUMMY_SP,
                    expr: Box::new(str_lit(WORKLET_DIRECTIVE)),
                }),
                Stmt::Return(ReturnStmt {
                    span: DUMMY_SP,
                    arg: Some(Box::new(Expr::Object(cloned))),
                }),
            ],
            ctxt: Default::default(),
        };
        let factory_method = MethodProp {
            key: PropName::Ident(IdentName::new(CONTEXT_OBJECT_FACTORY.into(), DUMMY_SP)),
            function: Box::new(Function {
                params: vec![],
                decorators: vec![],
                span: DUMMY_SP,
                ctxt: Default::default(),
                body: Some(factory_body),
                is_generator: false,
                is_async: false,
                type_params: None,
                return_type: None,
            }),
        };
        obj.props
            .push(PropOrSpread::Prop(Box::new(Prop::Method(factory_method))));
        true
    }

    /// Workletizes object methods whose body starts with a `'worklet'`
    /// directive. Unlike `force_workletize_obj` (used by object hooks), this
    /// only transforms methods that explicitly opt in.
    fn workletize_directive_methods(&mut self, obj: &mut ObjectLit) {
        let props = std::mem::take(&mut obj.props);
        let mut new_props = Vec::with_capacity(props.len());
        for mut p in props {
            if let PropOrSpread::Prop(prop_box) = &mut p {
                if let Prop::Method(m) = prop_box.as_mut() {
                    if let Some(body) = m.function.body.as_mut() {
                        if !Self::is_already_workletized(&body.stmts)
                            && Self::has_worklet_directive(&body.stmts)
                        {
                            Self::strip_worklet_directives(&mut body.stmts);
                            let params = m.function.params.clone();
                            let body_c = body.clone();
                            let cv = collect_closure_vars(&params, &body_c, &self.closure_ctx());
                            let name = prop_name_str(&m.key);
                            let fc = self.make_factory_call(
                                name,
                                params,
                                body_c,
                                cv,
                                m.function.is_generator,
                                m.function.is_async,
                            );
                            new_props.push(PropOrSpread::Prop(Box::new(Prop::KeyValue(
                                KeyValueProp {
                                    key: m.key.clone(),
                                    value: Box::new(fc),
                                },
                            ))));
                            continue;
                        }
                    }
                }
            }
            new_props.push(p);
        }
        obj.props = new_props;
    }

    // Pattern-guard collapse not possible: `kv.value` requires `&mut`, but
    // bindings inside a guard are immutable until the guard finishes.
    #[allow(clippy::collapsible_match)]
    fn force_workletize_obj(&mut self, obj: &mut ObjectLit) -> bool {
        let mut any = false;
        let props = std::mem::take(&mut obj.props);
        let mut new_props = Vec::with_capacity(props.len());
        for mut p in props {
            if let PropOrSpread::Prop(prop_box) = &mut p {
                match prop_box.as_mut() {
                    Prop::Method(m) => {
                        if let Some(body) = m.function.body.clone() {
                            let params = m.function.params.clone();
                            let cv = collect_closure_vars(&params, &body, &self.closure_ctx());
                            let name = prop_name_str(&m.key);
                            let fc = self.make_factory_call(
                                name,
                                params,
                                body,
                                cv,
                                m.function.is_generator,
                                m.function.is_async,
                            );
                            new_props.push(PropOrSpread::Prop(Box::new(Prop::KeyValue(
                                KeyValueProp {
                                    key: m.key.clone(),
                                    value: Box::new(fc),
                                },
                            ))));
                            any = true;
                            continue;
                        }
                    }
                    Prop::KeyValue(kv) => {
                        if self.force_workletize(&mut kv.value, true, false) {
                            any = true;
                        }
                    }
                    _ => {}
                }
            }
            new_props.push(p);
        }
        obj.props = new_props;
        any
    }

    // -------------------------------------------------------------------------
    // Auto-workletization detection
    // -------------------------------------------------------------------------

    fn is_gesture_callback(callee: &Expr) -> bool {
        if let Expr::Member(me) = callee {
            if let MemberProp::Ident(prop) = &me.prop {
                if GESTURE_BUILDER_METHODS.contains(&prop.sym.as_ref()) {
                    return contains_gesture_obj(&me.obj);
                }
            }
        }
        false
    }

    fn is_layout_anim_callback(callee: &Expr) -> bool {
        if let Expr::Member(me) = callee {
            if let MemberProp::Ident(prop) = &me.prop {
                if LAYOUT_ANIM_CALLBACKS.contains(&prop.sym.as_ref()) {
                    return is_layout_anim_chain(&me.obj);
                }
            }
        }
        false
    }

    // -------------------------------------------------------------------------
    // File-level worklet
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Referenced worklets
    //
    // A hook call receiving an identifier instead of an inline function is
    // resolved back to its binding site and that site is tagged with a
    // `'worklet'` directive so the regular workletization pass wraps it.
    //
    // Binding-site priority mirrors upstream reanimated and Babel scope
    // semantics:
    //     FunctionDeclaration  >  last AssignmentExpression  >  VariableDeclarator init
    //
    // Order-insensitivity: a hook may reference a name whose binding only
    // appears later in source order — Babel's scope resolution doesn't care
    // about line order, so neither does this pass.
    // -------------------------------------------------------------------------

    /// Find references and rewrite bindings for the module body. Runs before
    /// the main workletization visitor, so tagged bindings are picked up on
    /// the normal pass.
    ///
    /// Resolution handles nested scopes: bindings declared inside a function
    /// body (or nested block) are matched against references within that
    /// scope before the outer scope is considered.
    fn resolve_referenced_worklets(&self, items: &mut [ModuleItem]) {
        // Recurse into nested scopes first so inner bindings resolve local
        // references before outer scopes see them.
        for item in items.iter_mut() {
            resolve_refs_in_nested_scopes_item(item);
        }
        let mut refs: indexmap::IndexMap<Atom, bool> = indexmap::IndexMap::new();
        for item in items.iter() {
            match item {
                ModuleItem::Stmt(s) => collect_ref_names_stmt(s, &mut refs),
                ModuleItem::ModuleDecl(m) => collect_ref_names_moduledecl(m, &mut refs),
            }
        }
        if refs.is_empty() {
            return;
        }
        for (name, accept_obj) in refs {
            tag_best_binding_in_items(items, name.as_ref(), accept_obj);
        }
    }

    fn resolve_referenced_worklets_script(&self, stmts: &mut [Stmt]) {
        for stmt in stmts.iter_mut() {
            resolve_refs_in_nested_scopes_stmt(stmt);
        }
        let mut refs: indexmap::IndexMap<Atom, bool> = indexmap::IndexMap::new();
        for stmt in stmts.iter() {
            collect_ref_names_stmt(stmt, &mut refs);
        }
        if refs.is_empty() {
            return;
        }
        for (name, accept_obj) in refs {
            tag_best_binding_in_stmts(stmts, name.as_ref(), accept_obj);
        }
    }

    fn handle_file_worklet(&self, module: &mut Module) {
        let has = module.body.iter().any(|item| {
            if let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = item {
                if let Expr::Lit(Lit::Str(s)) = expr.as_ref() {
                    return s.value == *WORKLET_DIRECTIVE;
                }
            }
            false
        });
        if !has {
            return;
        }
        module.body.retain(|item| {
            if let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = item {
                if let Expr::Lit(Lit::Str(s)) = expr.as_ref() {
                    return s.value != *WORKLET_DIRECTIVE;
                }
            }
            true
        });
        // Move CJS exports (`module.exports = ...`, `exports.foo = ...`,
        // `Object.defineProperty(exports, ...)`) to the end of the file.
        // After workletization, top-level declarations are no longer
        // hoisted (they become `const` factory calls), so exports that
        // referenced those names from the top of the file would observe
        // `undefined`. Reordering preserves the original semantics.
        let mut non_exports: Vec<ModuleItem> = Vec::with_capacity(module.body.len());
        let mut cjs_exports: Vec<ModuleItem> = Vec::new();
        for item in std::mem::take(&mut module.body) {
            if is_cjs_export(&item) {
                cjs_exports.push(item);
            } else {
                non_exports.push(item);
            }
        }
        non_exports.extend(cjs_exports);
        module.body = non_exports;
        for item in &mut module.body {
            add_worklet_dir_item(item);
        }
    }

    fn handle_file_worklet_script(&self, script: &mut Script) {
        let has = script.body.iter().any(|s| {
            if let Stmt::Expr(ExprStmt { expr, .. }) = s {
                if let Expr::Lit(Lit::Str(s)) = expr.as_ref() {
                    return s.value == *WORKLET_DIRECTIVE;
                }
            }
            false
        });
        if !has {
            return;
        }
        script.body.retain(|s| {
            if let Stmt::Expr(ExprStmt { expr, .. }) = s {
                if let Expr::Lit(Lit::Str(s)) = expr.as_ref() {
                    return s.value != *WORKLET_DIRECTIVE;
                }
            }
            true
        });
        let mut non_exports: Vec<Stmt> = Vec::with_capacity(script.body.len());
        let mut cjs_exports: Vec<Stmt> = Vec::new();
        for stmt in std::mem::take(&mut script.body) {
            if is_cjs_export_stmt(&stmt) {
                cjs_exports.push(stmt);
            } else {
                non_exports.push(stmt);
            }
        }
        non_exports.extend(cjs_exports);
        script.body = non_exports;
        for stmt in &mut script.body {
            add_worklet_dir_stmt(stmt);
        }
    }

    // -------------------------------------------------------------------------
    // Inline styles warning
    // -------------------------------------------------------------------------

    fn maybe_warn_inline_styles(&self, attr: &mut JSXAttr) {
        if self.is_release || self.options.disable_inline_styles_warning {
            return;
        }
        if !matches!(&attr.name, JSXAttrName::Ident(id) if id.sym.as_ref() == "style") {
            return;
        }
        if let Some(JSXAttrValue::JSXExprContainer(c)) = &mut attr.value {
            if let JSXExpr::Expr(e) = &mut c.expr {
                match e.as_mut() {
                    Expr::Array(arr) => {
                        for ExprOrSpread { expr, .. } in arr.elems.iter_mut().flatten() {
                            if let Expr::Object(obj) = expr.as_mut() {
                                warn_obj(obj);
                            }
                        }
                    }
                    Expr::Object(obj) => warn_obj(obj),
                    _ => {}
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// VisitMut
// ---------------------------------------------------------------------------

impl VisitMut for WorkletsPlugin {
    fn visit_mut_module(&mut self, module: &mut Module) {
        self.handle_file_worklet(module);
        self.resolve_referenced_worklets(&mut module.body);
        let old = std::mem::take(&mut module.body);
        let mut out: Vec<ModuleItem> = Vec::with_capacity(old.len());
        for mut item in old {
            item.visit_mut_with(self);
            for p in self.pending_prepends.drain(..) {
                out.push(ModuleItem::Stmt(p));
            }
            out.push(item);
        }
        module.body = out;
    }

    fn visit_mut_script(&mut self, script: &mut Script) {
        self.handle_file_worklet_script(script);
        self.resolve_referenced_worklets_script(&mut script.body);
        let old = std::mem::take(&mut script.body);
        let mut out: Vec<Stmt> = Vec::with_capacity(old.len());
        for mut s in old {
            s.visit_mut_with(self);
            for p in self.pending_prepends.drain(..) {
                out.push(p);
            }
            out.push(s);
        }
        script.body = out;
    }

    fn visit_mut_block_stmt(&mut self, block: &mut BlockStmt) {
        // Don't drain pending_prepends here; init_data declarations are hoisted
        // to the module/script top level so nested worklets don't end up with
        // a local init_data decl inside an outer worklet's body — they reference
        // the hoisted identifier through the outer worklet's captured closure.
        block.visit_mut_children_with(self);
    }

    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        // Recurse children first
        expr.visit_mut_children_with(self);

        match expr {
            Expr::Fn(fn_expr) => {
                if let Some(new) = self.try_workletize_fn(None, fn_expr) {
                    *expr = new;
                }
            }
            Expr::Arrow(arrow) => {
                if let Some(new) = self.try_workletize_arrow(None, arrow) {
                    *expr = new;
                }
            }
            Expr::Object(obj) => {
                // Context-object expansion runs first so the synthesized
                // `__workletContextObjectFactory` method is picked up by the
                // directive-based pass below on the same visit.
                self.process_context_object(obj);
                self.workletize_directive_methods(obj);
            }
            Expr::Call(call) => {
                let callee_name = callee_ident(&call.callee);
                if let Some(name) = callee_name {
                    if let Some((_, idxs)) = function_hooks().iter().find(|(h, _)| *h == name) {
                        let accept_obj = is_object_hook(name);
                        let n = call.args.len();
                        for &idx in *idxs {
                            if idx < n {
                                self.force_workletize(&mut call.args[idx].expr, true, accept_obj);
                            }
                        }
                        return;
                    }
                }
                if let Callee::Expr(ce) = &call.callee.clone() {
                    if Self::is_gesture_callback(ce) {
                        for arg in &mut call.args {
                            self.force_workletize(&mut arg.expr, true, true);
                        }
                        return;
                    }
                    if Self::is_layout_anim_callback(ce) {
                        for arg in &mut call.args {
                            self.force_workletize(&mut arg.expr, true, false);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        if let Stmt::Decl(Decl::Fn(fn_decl)) = stmt {
            if let Some(var_decl) = self.try_workletize_fn_decl(fn_decl) {
                *stmt = Stmt::Decl(Decl::Var(Box::new(var_decl)));
            }
        } else {
            stmt.visit_mut_children_with(self);
        }
    }

    fn visit_mut_class(&mut self, class: &mut Class) {
        // Descend first so class-field initializers (arrow worklets, nested
        // worklet hooks) get wrapped before we reshape class members.
        class.visit_mut_children_with(self);
        self.workletize_class_body(class);
    }

    fn visit_mut_module_item(&mut self, item: &mut ModuleItem) {
        match item {
            // Named exported function / variable declaration.
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(e)) => match &mut e.decl {
                Decl::Fn(fn_decl) => {
                    if let Some(var_decl) = self.try_workletize_fn_decl(fn_decl) {
                        e.decl = Decl::Var(Box::new(var_decl));
                    }
                }
                Decl::Var(v) => {
                    v.visit_mut_with(self);
                }
                _ => e.decl.visit_mut_with(self),
            },
            // `export default function foo() { ... }` — we workletize the
            // function and rewrite to `const foo = factory; export default foo;`.
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(e)) => {
                if let DefaultDecl::Fn(fn_expr) = &mut e.decl {
                    if let Some(body) = fn_expr.function.body.as_mut() {
                        if !Self::is_already_workletized(&body.stmts)
                            && Self::has_worklet_directive(&body.stmts)
                        {
                            Self::strip_worklet_directives(&mut body.stmts);
                            let params = fn_expr.function.params.clone();
                            let body_c = body.clone();
                            let cv = collect_closure_vars(&params, &body_c, &self.closure_ctx());
                            let name = fn_expr.ident.as_ref().map(|i| i.sym.to_string());
                            let fc = self.make_factory_call(
                                name.as_deref(),
                                params,
                                body_c,
                                cv,
                                fn_expr.function.is_generator,
                                fn_expr.function.is_async,
                            );
                            *item = ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(
                                ExportDefaultExpr {
                                    span: DUMMY_SP,
                                    expr: Box::new(fc),
                                },
                            ));
                            return;
                        }
                    }
                }
                item.visit_mut_children_with(self);
            }
            _ => item.visit_mut_children_with(self),
        }
    }

    fn visit_mut_var_declarator(&mut self, decl: &mut VarDeclarator) {
        decl.visit_mut_children_with(self);
        if let Some(init) = &mut decl.init {
            let hint = pat_ident(&decl.name);
            match init.as_mut() {
                Expr::Fn(fn_expr) => {
                    if let Some(new) = self.try_workletize_fn(hint, fn_expr) {
                        **init = new;
                    }
                }
                Expr::Arrow(arrow) => {
                    if let Some(new) = self.try_workletize_arrow(hint, arrow) {
                        **init = new;
                    }
                }
                _ => {}
            }
        }
    }

    fn visit_mut_jsx_attr(&mut self, attr: &mut JSXAttr) {
        attr.visit_mut_children_with(self);
        self.maybe_warn_inline_styles(attr);
    }
}

// ---------------------------------------------------------------------------
// File-level worklet directive helpers
// ---------------------------------------------------------------------------

/// Recognize expression-statement CJS exports that should move to the bottom
/// of a file-workletized module. Accepts any assignment whose left-hand side
/// eventually roots at `module` or `exports` (so `module.exports = ...`,
/// `module.exports.foo = ...`, `exports.bar = ...`, `exports.baz.qux = ...`
/// all qualify), plus `Object.defineProperty(exports, ...)`.
fn is_cjs_export(item: &ModuleItem) -> bool {
    let ModuleItem::Stmt(stmt) = item else {
        return false;
    };
    is_cjs_export_stmt(stmt)
}

fn is_cjs_export_stmt(stmt: &Stmt) -> bool {
    let Stmt::Expr(ExprStmt { expr, .. }) = stmt else {
        return false;
    };
    match expr.as_ref() {
        Expr::Assign(AssignExpr {
            left,
            op: AssignOp::Assign,
            ..
        }) => {
            let AssignTarget::Simple(SimpleAssignTarget::Member(me)) = left else {
                return false;
            };
            member_root_is_cjs(&me.obj)
        }
        // `Object.defineProperty(exports, ...)`
        Expr::Call(CallExpr {
            callee: Callee::Expr(ce),
            args,
            ..
        }) => {
            let Expr::Member(me) = ce.as_ref() else {
                return false;
            };
            let Expr::Ident(obj) = me.obj.as_ref() else {
                return false;
            };
            if obj.sym.as_ref() != "Object" {
                return false;
            }
            let MemberProp::Ident(prop) = &me.prop else {
                return false;
            };
            if prop.sym.as_ref() != "defineProperty" {
                return false;
            }
            matches!(
                args.first().map(|a| a.expr.as_ref()),
                Some(Expr::Ident(id)) if id.sym.as_ref() == "exports"
            )
        }
        _ => false,
    }
}

/// Walk down a chain of member expressions to the root object; return true
/// when that root is `module` or `exports`.
fn member_root_is_cjs(expr: &Expr) -> bool {
    match expr {
        Expr::Ident(id) => matches!(id.sym.as_ref(), "module" | "exports"),
        Expr::Member(me) => member_root_is_cjs(&me.obj),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Referenced worklets — helpers
// ---------------------------------------------------------------------------

/// Scan a single statement for hook calls that pass an identifier argument
/// (not an inline function or object literal) and record the identifier name
/// along with whether the hook accepts an object shape.
/// Recursively resolve referenced worklets inside nested function/block
/// scopes. A function body is its own scope, so references inside it should
/// prefer bindings declared inside it over outer-scope bindings of the same
/// name.
fn resolve_refs_in_nested_scopes_item(item: &mut ModuleItem) {
    match item {
        ModuleItem::Stmt(s) => resolve_refs_in_nested_scopes_stmt(s),
        ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(e)) => {
            resolve_refs_in_nested_scopes_decl(&mut e.decl);
        }
        ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(e)) => match &mut e.decl {
            DefaultDecl::Fn(fn_expr) => {
                if let Some(body) = fn_expr.function.body.as_mut() {
                    resolve_refs_in_block(body);
                }
            }
            DefaultDecl::Class(class_expr) => {
                resolve_refs_in_class(&mut class_expr.class);
            }
            _ => {}
        },
        ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(e)) => {
            resolve_refs_in_nested_scopes_expr(&mut e.expr);
        }
        _ => {}
    }
}

fn resolve_refs_in_nested_scopes_stmt(stmt: &mut Stmt) {
    match stmt {
        Stmt::Decl(d) => resolve_refs_in_nested_scopes_decl(d),
        Stmt::Block(b) => resolve_refs_in_block(b),
        Stmt::If(i) => {
            resolve_refs_in_nested_scopes_stmt(&mut i.cons);
            if let Some(alt) = i.alt.as_mut() {
                resolve_refs_in_nested_scopes_stmt(alt);
            }
        }
        Stmt::While(w) => resolve_refs_in_nested_scopes_stmt(&mut w.body),
        Stmt::DoWhile(w) => resolve_refs_in_nested_scopes_stmt(&mut w.body),
        Stmt::For(f) => resolve_refs_in_nested_scopes_stmt(&mut f.body),
        Stmt::ForIn(f) => resolve_refs_in_nested_scopes_stmt(&mut f.body),
        Stmt::ForOf(f) => resolve_refs_in_nested_scopes_stmt(&mut f.body),
        Stmt::Try(t) => {
            resolve_refs_in_block(&mut t.block);
            if let Some(h) = t.handler.as_mut() {
                resolve_refs_in_block(&mut h.body);
            }
            if let Some(f) = t.finalizer.as_mut() {
                resolve_refs_in_block(f);
            }
        }
        Stmt::Expr(e) => resolve_refs_in_nested_scopes_expr(&mut e.expr),
        _ => {}
    }
}

fn resolve_refs_in_nested_scopes_decl(decl: &mut Decl) {
    match decl {
        Decl::Fn(fd) => {
            if let Some(body) = fd.function.body.as_mut() {
                resolve_refs_in_block(body);
            }
        }
        Decl::Var(v) => {
            for d in &mut v.decls {
                if let Some(init) = d.init.as_mut() {
                    resolve_refs_in_nested_scopes_expr(init);
                }
            }
        }
        Decl::Class(c) => resolve_refs_in_class(&mut c.class),
        _ => {}
    }
}

fn resolve_refs_in_nested_scopes_expr(expr: &mut Expr) {
    match expr {
        Expr::Fn(fn_expr) => {
            if let Some(body) = fn_expr.function.body.as_mut() {
                resolve_refs_in_block(body);
            }
        }
        Expr::Arrow(arrow) => {
            if let BlockStmtOrExpr::BlockStmt(b) = arrow.body.as_mut() {
                resolve_refs_in_block(b);
            }
        }
        Expr::Class(ce) => resolve_refs_in_class(&mut ce.class),
        _ => {}
    }
}

fn resolve_refs_in_class(class: &mut Class) {
    for m in &mut class.body {
        match m {
            ClassMember::Method(method) => {
                if let Some(body) = method.function.body.as_mut() {
                    resolve_refs_in_block(body);
                }
            }
            ClassMember::Constructor(c) => {
                if let Some(body) = c.body.as_mut() {
                    resolve_refs_in_block(body);
                }
            }
            ClassMember::ClassProp(p) => {
                if let Some(value) = p.value.as_mut() {
                    resolve_refs_in_nested_scopes_expr(value);
                }
            }
            _ => {}
        }
    }
}

fn resolve_refs_in_block(block: &mut BlockStmt) {
    // First, recurse deeper.
    for stmt in &mut block.stmts {
        resolve_refs_in_nested_scopes_stmt(stmt);
    }
    // Then, do binding resolution for references collected *within* this
    // scope against the bindings declared in this scope. Outer-scope
    // references to names not bound here fall through to outer resolution.
    let mut refs: indexmap::IndexMap<Atom, bool> = indexmap::IndexMap::new();
    for stmt in block.stmts.iter() {
        collect_ref_names_stmt(stmt, &mut refs);
    }
    if refs.is_empty() {
        return;
    }
    // Only act on references whose binding is present in this block.
    for (name, accept_obj) in refs {
        if has_binding_for(&block.stmts, name.as_ref()) {
            tag_best_binding_in_stmts(&mut block.stmts, name.as_ref(), accept_obj);
        }
    }
}

/// Does this statement list contain a binding for `name` (fn decl, var decl,
/// or any assignment to `name`)?
fn has_binding_for(stmts: &[Stmt], name: &str) -> bool {
    for stmt in stmts {
        if let Stmt::Decl(decl) = stmt {
            match decl {
                Decl::Fn(fd) if fd.ident.sym.as_ref() == name => return true,
                Decl::Var(v) => {
                    for d in &v.decls {
                        if let Pat::Ident(bi) = &d.name {
                            if bi.id.sym.as_ref() == name {
                                return true;
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        let mut finder = AssignToNameFinder {
            name,
            count: 0,
            last_seq_idx: None,
        };
        stmt.visit_with(&mut finder);
        if finder.last_seq_idx.is_some() {
            return true;
        }
    }
    false
}

fn collect_ref_names_stmt(stmt: &Stmt, out: &mut indexmap::IndexMap<Atom, bool>) {
    stmt.visit_with(&mut ReferenceCollector { out });
}

fn collect_ref_names_moduledecl(m: &ModuleDecl, out: &mut indexmap::IndexMap<Atom, bool>) {
    m.visit_with(&mut ReferenceCollector { out });
}

struct ReferenceCollector<'a> {
    out: &'a mut indexmap::IndexMap<Atom, bool>,
}

impl ReferenceCollector<'_> {
    /// Record an identifier that flows into a hook as a candidate for
    /// binding-based workletization. Sees through parens and sequences
    /// (same rules the main visitor applies), and, for object-accepting
    /// hooks, descends one level into an inline object literal to catch
    /// `{ onStart, ..., onEnd: ref }` patterns where the callback property
    /// value is a bare identifier reference.
    fn record_hook_arg(&mut self, expr: &Expr, accept_obj: bool) {
        match expr {
            Expr::Ident(id) => {
                self.out
                    .entry(id.sym.clone())
                    .and_modify(|v| *v |= accept_obj)
                    .or_insert(accept_obj);
            }
            Expr::Paren(p) => self.record_hook_arg(&p.expr, accept_obj),
            Expr::Seq(s) => {
                if let Some(last) = s.exprs.last() {
                    self.record_hook_arg(last, accept_obj);
                }
            }
            Expr::Object(obj) if accept_obj => {
                for prop in &obj.props {
                    if let PropOrSpread::Prop(p) = prop {
                        match p.as_ref() {
                            Prop::Shorthand(id) => {
                                self.out.entry(id.sym.clone()).or_insert(false);
                            }
                            Prop::KeyValue(kv) => {
                                if let Expr::Ident(id) = kv.value.as_ref() {
                                    self.out.entry(id.sym.clone()).or_insert(false);
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

impl Visit for ReferenceCollector<'_> {
    fn visit_call_expr(&mut self, call: &CallExpr) {
        call.visit_children_with(self);
        let Callee::Expr(ce) = &call.callee else {
            return;
        };
        // Pull the callee's name as a borrowed Atom so the rest of this
        // method can avoid an extra String allocation per call site.
        let callee_atom: Option<&Atom> = match ce.as_ref() {
            Expr::Ident(id) => Some(&id.sym),
            Expr::Member(me) => match &me.prop {
                MemberProp::Ident(p) => Some(&p.sym),
                _ => None,
            },
            _ => None,
        };
        let Some(name) = callee_atom else {
            return;
        };
        // Hook with explicit accept_obj knowledge
        if let Some((_, idxs)) = function_hooks().iter().find(|(h, _)| *h == name.as_ref()) {
            let accept_obj = is_object_hook(name);
            for &idx in *idxs {
                let Some(arg) = call.args.get(idx) else {
                    continue;
                };
                self.record_hook_arg(&arg.expr, accept_obj);
            }
            return;
        }
        // Chained gesture builder callback (`.onStart(ref)` etc.) — accepts
        // functions only.
        if let Expr::Member(me) = ce.as_ref() {
            if let MemberProp::Ident(prop) = &me.prop {
                if GESTURE_BUILDER_METHODS.contains(&prop.sym.as_ref())
                    && contains_gesture_obj(&me.obj)
                {
                    for arg in &call.args {
                        self.record_hook_arg(&arg.expr, false);
                    }
                }
            }
        }
    }
}

/// Binding-site choice: higher is better.
#[derive(Debug)]
enum RefTarget {
    FnDecl(usize),
    Assign {
        stmt_idx: usize,
        assign_idx_in_seq: usize,
    },
    VarDecl {
        stmt_idx: usize,
        declarator_idx: usize,
    },
}

/// Find the best binding to rewrite for `name` in a list of top-level items.
fn find_best_binding_items(items: &[ModuleItem], name: &str) -> Option<RefTarget> {
    let stmts: Vec<Option<&Stmt>> = items
        .iter()
        .map(|item| match item {
            ModuleItem::Stmt(s) => Some(s),
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(e)) => match &e.decl {
                // Reachable through `export const foo = ...` and `export function foo() {}`
                Decl::Fn(_) | Decl::Var(_) => None, // handled via decl_at below
                _ => None,
            },
            _ => None,
        })
        .collect();
    find_best_binding_impl(&stmts, name, |idx| item_as_decl(&items[idx]))
}

fn find_best_binding_stmts(stmts: &[Stmt], name: &str) -> Option<RefTarget> {
    let stmts_opt: Vec<Option<&Stmt>> = stmts.iter().map(Some).collect();
    find_best_binding_impl(&stmts_opt, name, |idx| stmt_as_decl(&stmts[idx]))
}

fn item_as_decl(item: &ModuleItem) -> Option<&Decl> {
    match item {
        ModuleItem::Stmt(Stmt::Decl(d)) => Some(d),
        ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(e)) => Some(&e.decl),
        ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_)) => None,
        _ => None,
    }
}

fn stmt_as_decl(stmt: &Stmt) -> Option<&Decl> {
    match stmt {
        Stmt::Decl(d) => Some(d),
        _ => None,
    }
}

fn find_best_binding_impl<'a, F>(
    stmts: &'a [Option<&'a Stmt>],
    name: &str,
    mut decl_at: F,
) -> Option<RefTarget>
where
    F: FnMut(usize) -> Option<&'a Decl>,
{
    let mut fn_decl_idx: Option<usize> = None;
    let mut last_assign: Option<(usize, usize)> = None;
    let mut var_decl: Option<(usize, usize)> = None;

    for (idx, _) in stmts.iter().enumerate() {
        if let Some(decl) = decl_at(idx) {
            match decl {
                Decl::Fn(fd) if fd.ident.sym.as_ref() == name && fn_decl_idx.is_none() => {
                    fn_decl_idx = Some(idx);
                }
                Decl::Var(v) => {
                    for (di, d) in v.decls.iter().enumerate() {
                        if let Pat::Ident(bi) = &d.name {
                            if bi.id.sym.as_ref() == name && d.init.is_some() && var_decl.is_none()
                            {
                                var_decl = Some((idx, di));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(stmt) = stmts.get(idx).and_then(|s| s.as_ref()) {
            let mut assign_finder = AssignToNameFinder {
                name,
                count: 0,
                last_seq_idx: None,
            };
            stmt.visit_with(&mut assign_finder);
            if let Some(seq_idx) = assign_finder.last_seq_idx {
                last_assign = Some((idx, seq_idx));
            }
        }
    }

    if let Some(idx) = fn_decl_idx {
        return Some(RefTarget::FnDecl(idx));
    }
    if let Some((idx, seq)) = last_assign {
        return Some(RefTarget::Assign {
            stmt_idx: idx,
            assign_idx_in_seq: seq,
        });
    }
    if let Some((idx, di)) = var_decl {
        return Some(RefTarget::VarDecl {
            stmt_idx: idx,
            declarator_idx: di,
        });
    }
    None
}

/// Count assignments to `name` within a statement, recording the sequence
/// index of the last one (relative to all assignments to `name` found during
/// the visit — used to pick "the last write to `foo`").
struct AssignToNameFinder<'a> {
    name: &'a str,
    count: usize,
    last_seq_idx: Option<usize>,
}

impl Visit for AssignToNameFinder<'_> {
    fn visit_assign_expr(&mut self, node: &AssignExpr) {
        if matches!(node.op, AssignOp::Assign) {
            if let AssignTarget::Simple(SimpleAssignTarget::Ident(bi)) = &node.left {
                if bi.id.sym.as_ref() == self.name {
                    self.last_seq_idx = Some(self.count);
                    self.count += 1;
                }
            }
        }
        node.visit_children_with(self);
    }
}

fn tag_best_binding_in_items(items: &mut [ModuleItem], name: &str, accept_obj: bool) {
    let Some(target) = find_best_binding_items(items, name) else {
        return;
    };
    match target {
        RefTarget::FnDecl(idx) => {
            if let Some(Decl::Fn(fd)) = item_as_decl_mut(&mut items[idx]) {
                if let Some(body) = fd.function.body.as_mut() {
                    push_dir(body);
                }
            }
        }
        RefTarget::VarDecl {
            stmt_idx,
            declarator_idx,
        } => {
            if let Some(Decl::Var(v)) = item_as_decl_mut(&mut items[stmt_idx]) {
                if let Some(d) = v.decls.get_mut(declarator_idx) {
                    if let Some(init) = d.init.as_mut() {
                        tag_expr_for_hook_ref(init, accept_obj);
                    }
                }
            }
        }
        RefTarget::Assign {
            stmt_idx,
            assign_idx_in_seq,
        } => {
            if let Some(stmt) = item_as_stmt_mut(&mut items[stmt_idx]) {
                tag_nth_assign_rhs(stmt, name, assign_idx_in_seq, accept_obj);
            }
        }
    }
}

fn tag_best_binding_in_stmts(stmts: &mut [Stmt], name: &str, accept_obj: bool) {
    let Some(target) = find_best_binding_stmts(stmts, name) else {
        return;
    };
    match target {
        RefTarget::FnDecl(idx) => {
            if let Stmt::Decl(Decl::Fn(fd)) = &mut stmts[idx] {
                if let Some(body) = fd.function.body.as_mut() {
                    push_dir(body);
                }
            }
        }
        RefTarget::VarDecl {
            stmt_idx,
            declarator_idx,
        } => {
            if let Stmt::Decl(Decl::Var(v)) = &mut stmts[stmt_idx] {
                if let Some(d) = v.decls.get_mut(declarator_idx) {
                    if let Some(init) = d.init.as_mut() {
                        tag_expr_for_hook_ref(init, accept_obj);
                    }
                }
            }
        }
        RefTarget::Assign {
            stmt_idx,
            assign_idx_in_seq,
        } => {
            tag_nth_assign_rhs(&mut stmts[stmt_idx], name, assign_idx_in_seq, accept_obj);
        }
    }
}

fn item_as_decl_mut(item: &mut ModuleItem) -> Option<&mut Decl> {
    match item {
        ModuleItem::Stmt(Stmt::Decl(d)) => Some(d),
        ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(e)) => Some(&mut e.decl),
        _ => None,
    }
}

fn item_as_stmt_mut(item: &mut ModuleItem) -> Option<&mut Stmt> {
    match item {
        ModuleItem::Stmt(s) => Some(s),
        _ => None,
    }
}

/// Mutate an expression to opt it into workletization for a hook reference.
/// Functions and arrows get the `'worklet'` directive pushed onto their body;
/// an object literal (accepted only when the enclosing hook takes objects)
/// has the directive pushed onto each of its methods.
fn tag_expr_for_hook_ref(expr: &mut Expr, accept_obj: bool) {
    match expr {
        Expr::Fn(fn_expr) => {
            if let Some(body) = fn_expr.function.body.as_mut() {
                push_dir(body);
            }
        }
        Expr::Arrow(arrow) => {
            ensure_block_body(arrow);
            if let BlockStmtOrExpr::BlockStmt(b) = arrow.body.as_mut() {
                push_dir(b);
            }
        }
        Expr::Object(obj) if accept_obj => {
            for prop in &mut obj.props {
                if let PropOrSpread::Prop(p) = prop {
                    match p.as_mut() {
                        Prop::Method(m) => {
                            if let Some(body) = m.function.body.as_mut() {
                                push_dir(body);
                            }
                        }
                        Prop::KeyValue(kv) => {
                            // `onScroll: (e) => {...}` / `onScroll: function(){}`
                            tag_expr_for_hook_ref(&mut kv.value, false);
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
}

/// Walk `stmt` looking for the `nth` assignment to `name` (in source order)
/// and tag its RHS. Used for the "last assign wins" rule when we've
/// determined which assignment index should be workletized.
fn tag_nth_assign_rhs(stmt: &mut Stmt, name: &str, nth: usize, accept_obj: bool) {
    let mut tagger = AssignTagger {
        name,
        nth,
        count: 0,
        accept_obj,
        done: false,
    };
    stmt.visit_mut_with(&mut tagger);
}

struct AssignTagger<'a> {
    name: &'a str,
    nth: usize,
    count: usize,
    accept_obj: bool,
    done: bool,
}

impl VisitMut for AssignTagger<'_> {
    fn visit_mut_assign_expr(&mut self, node: &mut AssignExpr) {
        if self.done {
            return;
        }
        if matches!(node.op, AssignOp::Assign) {
            if let AssignTarget::Simple(SimpleAssignTarget::Ident(bi)) = &node.left {
                if bi.id.sym.as_ref() == self.name {
                    if self.count == self.nth {
                        tag_expr_for_hook_ref(&mut node.right, self.accept_obj);
                        self.done = true;
                        return;
                    }
                    self.count += 1;
                }
            }
        }
        node.visit_mut_children_with(self);
    }
}

fn add_worklet_dir_item(item: &mut ModuleItem) {
    match item {
        ModuleItem::Stmt(s) => add_worklet_dir_stmt(s),
        ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(e)) => add_worklet_dir_decl(&mut e.decl),
        ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(e)) => {
            add_worklet_dir_expr(&mut e.expr)
        }
        ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(e)) => match &mut e.decl {
            DefaultDecl::Fn(fn_expr) => {
                if let Some(b) = fn_expr.function.body.as_mut() {
                    push_dir(b);
                }
            }
            DefaultDecl::Class(class_expr) => {
                add_worklet_dir_class(&mut class_expr.class);
            }
            DefaultDecl::TsInterfaceDecl(_) => {}
        },
        _ => {}
    }
}

fn add_worklet_dir_stmt(stmt: &mut Stmt) {
    match stmt {
        Stmt::Decl(d) => add_worklet_dir_decl(d),
        Stmt::Expr(ExprStmt { expr, .. }) => add_worklet_dir_expr(expr),
        _ => {}
    }
}

fn add_worklet_dir_decl(decl: &mut Decl) {
    match decl {
        Decl::Fn(fn_decl) => {
            if let Some(b) = fn_decl.function.body.as_mut() {
                push_dir(b);
            }
        }
        Decl::Var(v) => {
            for d in &mut v.decls {
                if let Some(init) = &mut d.init {
                    add_worklet_dir_expr(init);
                }
            }
        }
        Decl::Class(class_decl) => {
            add_worklet_dir_class(&mut class_decl.class);
        }
        _ => {}
    }
}

fn add_worklet_dir_expr(expr: &mut Expr) {
    match expr {
        Expr::Fn(fn_expr) => {
            if let Some(b) = fn_expr.function.body.as_mut() {
                push_dir(b);
            }
        }
        Expr::Arrow(arrow) => match arrow.body.as_mut() {
            BlockStmtOrExpr::BlockStmt(b) => push_dir(b),
            BlockStmtOrExpr::Expr(inner) => {
                let i = inner.clone();
                let mut block = BlockStmt {
                    span: DUMMY_SP,
                    stmts: vec![Stmt::Return(ReturnStmt {
                        span: DUMMY_SP,
                        arg: Some(i),
                    })],
                    ctxt: Default::default(),
                };
                push_dir(&mut block);
                *arrow.body = BlockStmtOrExpr::BlockStmt(block);
            }
        },
        Expr::Object(obj) => add_worklet_dir_object(obj),
        Expr::Class(class_expr) => {
            add_worklet_dir_class(&mut class_expr.class);
        }
        _ => {}
    }
}

/// A top-level `'worklet';` directive opts every method of a class into
/// workletization. The per-method pass (`workletize_class_body`) will then
/// pick each one up.
fn add_worklet_dir_class(class: &mut Class) {
    for member in &mut class.body {
        match member {
            ClassMember::Method(m) => {
                if let Some(body) = m.function.body.as_mut() {
                    push_dir(body);
                }
            }
            ClassMember::Constructor(c) => {
                if let Some(body) = c.body.as_mut() {
                    push_dir(body);
                }
            }
            ClassMember::ClassProp(p) => {
                if let Some(value) = p.value.as_mut() {
                    add_worklet_dir_expr(value);
                }
            }
            _ => {}
        }
    }
}

/// An object literal under a top-level `'worklet';` directive takes one of
/// two shapes, mirroring upstream reanimated's `processWorkletAggregator` /
/// `isImplicitContextObject`:
///
///   - If any method body references `this`, the whole object is treated as
///     an implicit context object — we append the `__workletContextObject`
///     marker so the context-object pass handles it as a unit (preserving
///     the shared `this` binding across methods).
///   - Otherwise, each method/function-valued property gets its own
///     `'worklet'` directive.
fn add_worklet_dir_object(obj: &mut ObjectLit) {
    if object_lit_has_this_method(obj) {
        if !obj.props.iter().any(is_context_object_marker) {
            obj.props
                .push(PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(IdentName::new(CONTEXT_OBJECT_MARKER.into(), DUMMY_SP)),
                    value: Box::new(Expr::Lit(Lit::Bool(Bool {
                        span: DUMMY_SP,
                        value: true,
                    }))),
                }))));
        }
        return;
    }
    for prop in &mut obj.props {
        if let PropOrSpread::Prop(p) = prop {
            match p.as_mut() {
                Prop::Method(m) => {
                    if let Some(body) = m.function.body.as_mut() {
                        push_dir(body);
                    }
                }
                Prop::KeyValue(kv) => {
                    add_worklet_dir_expr(&mut kv.value);
                }
                _ => {}
            }
        }
    }
}

/// Does the object literal contain at least one `ObjectMethod` whose body
/// references `this`? Matches upstream reanimated's implicit-context-object
/// check — only methods count (arrow/function properties don't bind `this`
/// to the object).
fn object_lit_has_this_method(obj: &ObjectLit) -> bool {
    obj.props.iter().any(|prop| {
        let PropOrSpread::Prop(p) = prop else {
            return false;
        };
        let Prop::Method(m) = p.as_ref() else {
            return false;
        };
        let Some(body) = m.function.body.as_ref() else {
            return false;
        };
        let mut seeker = ThisFinder { found: false };
        body.visit_with(&mut seeker);
        seeker.found
    })
}

struct ThisFinder {
    found: bool,
}

impl Visit for ThisFinder {
    fn visit_this_expr(&mut self, _: &ThisExpr) {
        self.found = true;
    }

    // Don't cross into nested functions/classes — `this` inside those is
    // rebound and unrelated to the outer object.
    fn visit_function(&mut self, _: &Function) {}
    fn visit_class(&mut self, _: &Class) {}
    // Arrow functions *do* inherit `this`, so keep recursing through them.
}

fn push_dir(block: &mut BlockStmt) {
    if !block
        .stmts
        .iter()
        .any(|s| str_stmt_value(s) == Some(WORKLET_DIRECTIVE))
    {
        block.stmts.insert(
            0,
            Stmt::Expr(ExprStmt {
                span: DUMMY_SP,
                expr: Box::new(Expr::Lit(Lit::Str(Str {
                    span: DUMMY_SP,
                    value: WORKLET_DIRECTIVE.into(),
                    raw: None,
                }))),
            }),
        );
    }
}

// Inline-style warning lives in `inline_style.rs`.
// Gesture / layout-animation chain detection lives in `gestures.rs`.

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

fn make_ident(s: &str) -> Ident {
    Ident::new(s.into(), DUMMY_SP, Default::default())
}
pub(crate) fn mk_ident(s: &str) -> Expr {
    Expr::Ident(make_ident(s))
}
pub(crate) fn str_lit(s: &str) -> Expr {
    Expr::Lit(Lit::Str(Str {
        span: DUMMY_SP,
        value: s.into(),
        raw: None,
    }))
}
fn num_lit(n: f64) -> Expr {
    Expr::Lit(Lit::Num(Number {
        span: DUMMY_SP,
        value: n,
        raw: None,
    }))
}
fn shorthand(name: &str) -> PropOrSpread {
    PropOrSpread::Prop(Box::new(Prop::Shorthand(make_ident(name))))
}

fn make_assign(target: &str, prop: &str, value: Expr) -> Stmt {
    Stmt::Expr(ExprStmt {
        span: DUMMY_SP,
        expr: Box::new(Expr::Assign(AssignExpr {
            span: DUMMY_SP,
            op: AssignOp::Assign,
            left: AssignTarget::Simple(SimpleAssignTarget::Member(MemberExpr {
                span: DUMMY_SP,
                obj: Box::new(mk_ident(target)),
                prop: MemberProp::Ident(IdentName::new(prop.into(), DUMMY_SP)),
            })),
            right: Box::new(value),
        })),
    })
}

fn make_const_fn(
    name: &str,
    params: Vec<Param>,
    body: BlockStmt,
    is_generator: bool,
    is_async: bool,
) -> Stmt {
    Stmt::Decl(Decl::Var(Box::new(VarDecl {
        span: DUMMY_SP,
        ctxt: Default::default(),
        kind: VarDeclKind::Const,
        declare: false,
        decls: vec![VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: make_ident(name),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Fn(FnExpr {
                ident: Some(make_ident(name)),
                function: Box::new(Function {
                    params,
                    decorators: vec![],
                    span: DUMMY_SP,
                    ctxt: Default::default(),
                    body: Some(body),
                    is_generator,
                    is_async,
                    type_params: None,
                    return_type: None,
                }),
            }))),
            definite: false,
        }],
    })))
}

/// `const <name> = this._recur;`
fn make_recur_decl(name: &str) -> Stmt {
    Stmt::Decl(Decl::Var(Box::new(VarDecl {
        span: DUMMY_SP,
        ctxt: Default::default(),
        kind: VarDeclKind::Const,
        declare: false,
        decls: vec![VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: make_ident(name),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Member(MemberExpr {
                span: DUMMY_SP,
                obj: Box::new(Expr::This(ThisExpr { span: DUMMY_SP })),
                prop: MemberProp::Ident(IdentName::new("_recur".into(), DUMMY_SP)),
            }))),
            definite: false,
        }],
    })))
}

/// Rewrite free (non-shadowed) identifier references named `from` inside
/// `body` to `to`. Returns `true` if at least one reference was renamed.
///
/// Scope rules mirror closure collection:
///   - parameters declared at the enclosing function scope never match
///   - local declarations (`var`/`let`/`const`, fn/class decls, catch params,
///     for-loop vars) shadow `from` within the remaining body
///   - nested functions that re-declare `from` as a parameter or local shadow
///     it within their own scope
fn rename_free_refs(body: &mut BlockStmt, from: &str, to: &str) -> bool {
    let mut declared: IndexSet<Atom> = IndexSet::new();
    let mut decl_collector = DeclCollector {
        declared: &mut declared,
        depth: 0,
    };
    body.visit_with(&mut decl_collector);
    let from_atom = Atom::from(from);
    if declared.contains(&from_atom) {
        // The body locally redeclares `from` — nothing to rewrite.
        return false;
    }
    let mut renamer = FreeRefRenamer {
        from: from_atom,
        to: Atom::from(to),
        declared,
        renamed: false,
    };
    body.visit_mut_with(&mut renamer);
    renamer.renamed
}

struct FreeRefRenamer {
    from: Atom,
    to: Atom,
    declared: IndexSet<Atom>,
    renamed: bool,
}

impl FreeRefRenamer {
    fn with_inner<F: FnOnce(&mut Self)>(&mut self, extra: &[Atom], f: F) {
        // Collect extras (e.g. inner-function params) into a shadowing scope
        // while running the body walk, then restore.
        let mut added: Vec<Atom> = vec![];
        for name in extra {
            if !self.declared.contains(name) {
                self.declared.insert(name.clone());
                added.push(name.clone());
            }
        }
        f(self);
        for name in &added {
            self.declared.shift_remove(name);
        }
    }
}

impl VisitMut for FreeRefRenamer {
    fn visit_mut_ident(&mut self, ident: &mut Ident) {
        if ident.sym == self.from && !self.declared.contains(&self.from) {
            ident.sym = self.to.clone();
            self.renamed = true;
        }
    }

    // Don't rename a `.foo` property access.
    fn visit_mut_member_expr(&mut self, node: &mut MemberExpr) {
        node.obj.visit_mut_with(self);
        if let MemberProp::Computed(c) = &mut node.prop {
            c.expr.visit_mut_with(self);
        }
    }

    // Don't rename object property KEYS (shorthand keys and computed keys
    // still need handling).
    fn visit_mut_prop(&mut self, prop: &mut Prop) {
        match prop {
            Prop::Shorthand(id) => {
                self.visit_mut_ident(id);
            }
            Prop::KeyValue(kv) => {
                if let PropName::Computed(c) = &mut kv.key {
                    c.expr.visit_mut_with(self);
                }
                kv.value.visit_mut_with(self);
            }
            Prop::Assign(a) => {
                a.value.visit_mut_with(self);
            }
            Prop::Getter(g) => {
                if let PropName::Computed(c) = &mut g.key {
                    c.expr.visit_mut_with(self);
                }
                if let Some(body) = g.body.as_mut() {
                    body.visit_mut_with(self);
                }
            }
            Prop::Setter(s) => {
                if let PropName::Computed(c) = &mut s.key {
                    c.expr.visit_mut_with(self);
                }
                let mut extras: IndexSet<Atom> = IndexSet::new();
                collect_pat_bindings(&s.param, &mut extras);
                let extras_vec: Vec<Atom> = extras.into_iter().collect();
                self.with_inner(&extras_vec, |v| {
                    if let Some(body) = s.body.as_mut() {
                        body.visit_mut_with(v);
                    }
                });
            }
            Prop::Method(m) => {
                if let PropName::Computed(c) = &mut m.key {
                    c.expr.visit_mut_with(self);
                }
                let mut extras: IndexSet<Atom> = IndexSet::new();
                for p in &m.function.params {
                    collect_pat_bindings(&p.pat, &mut extras);
                }
                if let Some(body) = &m.function.body {
                    let mut dc = DeclCollector {
                        declared: &mut extras,
                        depth: 0,
                    };
                    body.visit_with(&mut dc);
                }
                let extras_vec: Vec<Atom> = extras.into_iter().collect();
                self.with_inner(&extras_vec, |v| {
                    if let Some(body) = m.function.body.as_mut() {
                        body.visit_mut_with(v);
                    }
                });
            }
        }
    }

    fn visit_mut_function(&mut self, node: &mut Function) {
        let mut extras: IndexSet<Atom> = IndexSet::new();
        for p in &node.params {
            collect_pat_bindings(&p.pat, &mut extras);
        }
        if let Some(body) = &node.body {
            let mut dc = DeclCollector {
                declared: &mut extras,
                depth: 0,
            };
            body.visit_with(&mut dc);
        }
        let extras_vec: Vec<Atom> = extras.into_iter().collect();
        self.with_inner(&extras_vec, |v| {
            if let Some(body) = node.body.as_mut() {
                body.visit_mut_with(v);
            }
        });
    }

    fn visit_mut_arrow_expr(&mut self, node: &mut ArrowExpr) {
        let mut extras: IndexSet<Atom> = IndexSet::new();
        for p in &node.params {
            collect_pat_bindings(p, &mut extras);
        }
        if let BlockStmtOrExpr::BlockStmt(block) = &*node.body {
            let mut dc = DeclCollector {
                declared: &mut extras,
                depth: 0,
            };
            block.visit_with(&mut dc);
        }
        let extras_vec: Vec<Atom> = extras.into_iter().collect();
        self.with_inner(&extras_vec, |v| {
            node.body.visit_mut_with(v);
        });
    }

    // Skip TS type annotations entirely.
    fn visit_mut_ts_type(&mut self, _: &mut TsType) {}
    fn visit_mut_ts_type_ann(&mut self, _: &mut TsTypeAnn) {}
    fn visit_mut_ts_type_param_decl(&mut self, _: &mut TsTypeParamDecl) {}
    fn visit_mut_ts_type_param_instantiation(&mut self, _: &mut TsTypeParamInstantiation) {}
}

fn make_stack_details_decl() -> Stmt {
    Stmt::Decl(Decl::Var(Box::new(VarDecl {
        span: DUMMY_SP,
        ctxt: Default::default(),
        kind: VarDeclKind::Const,
        declare: false,
        decls: vec![VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: make_ident("_e"),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Array(ArrayLit {
                span: DUMMY_SP,
                elems: vec![
                    Some(ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::New(NewExpr {
                            span: DUMMY_SP,
                            ctxt: Default::default(),
                            callee: Box::new(Expr::Member(MemberExpr {
                                span: DUMMY_SP,
                                obj: Box::new(mk_ident("global")),
                                prop: MemberProp::Ident(IdentName::new("Error".into(), DUMMY_SP)),
                            })),
                            args: Some(vec![]),
                            type_args: None,
                        })),
                    }),
                    Some(ExprOrSpread {
                        spread: None,
                        expr: Box::new(num_lit(1.0)),
                    }),
                    Some(ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Unary(UnaryExpr {
                            span: DUMMY_SP,
                            op: UnaryOp::Minus,
                            arg: Box::new(num_lit(27.0)),
                        })),
                    }),
                ],
            }))),
            definite: false,
        }],
    })))
}

fn make_init_data_decl(id: &str, code: &str, location: &str, source_map: Option<&str>) -> Stmt {
    let mut props = vec![PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
        key: PropName::Ident(IdentName::new("code".into(), DUMMY_SP)),
        value: Box::new(str_lit(code)),
    })))];
    if !location.is_empty() {
        props.push(PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
            key: PropName::Ident(IdentName::new("location".into(), DUMMY_SP)),
            value: Box::new(str_lit(location)),
        }))));
    }
    if let Some(sm) = source_map {
        props.push(PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
            key: PropName::Ident(IdentName::new("sourceMap".into(), DUMMY_SP)),
            value: Box::new(str_lit(sm)),
        }))));
    }
    Stmt::Decl(Decl::Var(Box::new(VarDecl {
        span: DUMMY_SP,
        ctxt: Default::default(),
        kind: VarDeclKind::Const,
        declare: false,
        decls: vec![VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: make_ident(id),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Object(ObjectLit {
                span: DUMMY_SP,
                props,
            }))),
            definite: false,
        }],
    })))
}

fn factory_param(cv: &[Ident], init_id: &str) -> Param {
    let mut props: Vec<ObjectPatProp> = vec![ObjectPatProp::Assign(AssignPatProp {
        span: DUMMY_SP,
        key: BindingIdent {
            id: make_ident(init_id),
            type_ann: None,
        },
        value: None,
    })];
    for v in cv {
        props.push(ObjectPatProp::Assign(AssignPatProp {
            span: DUMMY_SP,
            key: BindingIdent {
                id: make_ident(v.sym.as_ref()),
                type_ann: None,
            },
            value: None,
        }));
    }
    Param {
        span: DUMMY_SP,
        decorators: vec![],
        pat: Pat::Object(ObjectPat {
            span: DUMMY_SP,
            props,
            optional: false,
            type_ann: None,
        }),
    }
}

fn factory_call_obj(cv: &[Ident], init_id: &str) -> Expr {
    let mut props = vec![shorthand(init_id)];
    // Emit explicit `{ name: <origIdent> }` key-value pairs — NOT
    // shorthand — so SWC's later ESM→CJS pass sees a value expression
    // carrying the original `SyntaxContext`. Without that, an imported
    // binding like `RuntimeKind` stays as a bare reference to a nonexistent
    // top-level variable (the import was rewritten to `_mod.RuntimeKind`
    // everywhere else in the module).
    for v in cv {
        props.push(PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
            key: PropName::Ident(IdentName::new(v.sym.clone(), DUMMY_SP)),
            value: Box::new(Expr::Ident(v.clone())),
        }))));
    }
    Expr::Object(ObjectLit {
        span: DUMMY_SP,
        props,
    })
}

pub(crate) fn prop_name_str(name: &PropName) -> Option<&str> {
    match name {
        PropName::Ident(id) => Some(id.sym.as_ref()),
        // Wtf8Atom::as_str returns Some(&str) for valid UTF-8 atoms (the
        // common case). The lossy conversion only matters for unpaired
        // surrogates, which can't appear in a worklet marker name anyway —
        // every caller compares against an ASCII constant.
        PropName::Str(s) => s.value.as_str(),
        _ => None,
    }
}

fn pat_ident(pat: &Pat) -> Option<&str> {
    if let Pat::Ident(id) = pat {
        Some(id.id.sym.as_ref())
    } else {
        None
    }
}

fn callee_ident(callee: &Callee) -> Option<&str> {
    match callee {
        Callee::Expr(e) => match e.as_ref() {
            Expr::Ident(id) => Some(id.sym.as_ref()),
            Expr::Member(me) => {
                if let MemberProp::Ident(p) = &me.prop {
                    Some(p.sym.as_ref())
                } else {
                    None
                }
            }
            _ => None,
        },
        _ => None,
    }
}

/// True when a class member is the `__workletClass` marker property
/// (regardless of value — matches upstream reanimated behavior).
fn is_worklet_class_marker(member: &ClassMember) -> bool {
    let ClassMember::ClassProp(p) = member else {
        return false;
    };
    prop_name_str(&p.key) == Some(WORKLET_CLASS_MARKER)
}

/// The presence of a `__workletContextObject` property triggers expansion
/// regardless of the property's value — matches upstream reanimated, which
/// treats the marker as a discriminator rather than a boolean flag.
fn is_context_object_marker(prop: &PropOrSpread) -> bool {
    let PropOrSpread::Prop(prop_box) = prop else {
        return false;
    };
    let name = match prop_box.as_ref() {
        Prop::KeyValue(kv) => prop_name_str(&kv.key),
        Prop::Shorthand(id) => Some(id.sym.as_ref()),
        Prop::Method(m) => prop_name_str(&m.key),
        _ => None,
    };
    name == Some(CONTEXT_OBJECT_MARKER)
}

fn str_stmt_value(s: &Stmt) -> Option<&str> {
    if let Stmt::Expr(ExprStmt { expr, .. }) = s {
        if let Expr::Lit(Lit::Str(sv)) = expr.as_ref() {
            return sv.value.as_str();
        }
    }
    None
}

/// Port of Babel's `@babel/types` `toIdentifier`.
///
/// - Replaces every char that isn't a valid identifier char with `-`
/// - Strips leading `-` and digits
/// - Collapses `-` sequences by upper-casing the following letter (camelCase)
/// - Prefixes with `_` if the result isn't a valid identifier
/// - Returns `_` for an empty result
fn sanitize_ident(s: &str) -> String {
    fn is_ident_char(c: char) -> bool {
        c.is_alphanumeric() || c == '_' || c == '$'
    }
    let mapped: String = s
        .chars()
        .map(|c| if is_ident_char(c) { c } else { '-' })
        .collect();

    // Strip leading `-` or digits.
    let trimmed: String = {
        let mut it = mapped.chars().peekable();
        while let Some(&c) = it.peek() {
            if c == '-' || c.is_ascii_digit() {
                it.next();
            } else {
                break;
            }
        }
        it.collect()
    };

    // Collapse `[-\s]+(.)?` to `X.toUpperCase()` (or "" if no next char).
    let mut out = String::with_capacity(trimmed.len());
    let mut chars = trimmed.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '-' || c.is_whitespace() {
            while let Some(&nc) = chars.peek() {
                if nc == '-' || nc.is_whitespace() {
                    chars.next();
                } else {
                    break;
                }
            }
            if let Some(nc) = chars.next() {
                for up in nc.to_uppercase() {
                    out.push(up);
                }
            }
        } else {
            out.push(c);
        }
    }

    if out.is_empty() {
        return "_".to_string();
    }
    if out
        .chars()
        .next()
        .map(|c| c.is_ascii_digit())
        .unwrap_or(false)
    {
        return format!("_{}", out);
    }
    out
}

fn ensure_block_body(arrow: &mut ArrowExpr) {
    if let BlockStmtOrExpr::Expr(e) = arrow.body.as_mut() {
        let inner = e.clone();
        *arrow.body = BlockStmtOrExpr::BlockStmt(BlockStmt {
            span: DUMMY_SP,
            stmts: vec![Stmt::Return(ReturnStmt {
                span: DUMMY_SP,
                arg: Some(inner),
            })],
            ctxt: Default::default(),
        });
    }
}

// ---------------------------------------------------------------------------
// Worklet code string generation
// ---------------------------------------------------------------------------

/// Emit the worklet function expression as a source string, and — when a
/// `SourceMap` is provided — a stringified JSON source map tracking the
/// original positions of the AST nodes copied from the source.
///
/// When no `SourceMap` is provided (e.g. the wasm plugin path, which only
/// exposes a proxy), the source map is `None` and callers fall back to
/// emitting the mock placeholder.
#[allow(clippy::too_many_arguments)]
fn build_worklet_code_and_map(
    worklet_name: &str,
    params: &[Param],
    body: &BlockStmt,
    cv: &[Ident],
    is_generator: bool,
    is_async: bool,
    cm: Option<&Lrc<SourceMap>>,
    location: &str,
) -> (String, Option<String>) {
    let mut stmts = body.stmts.clone();
    if !cv.is_empty() {
        stmts.insert(0, make_closure_destruct_stmt(cv));
    }
    let fn_expr = Expr::Fn(FnExpr {
        ident: Some(make_ident(worklet_name)),
        function: Box::new(Function {
            params: params.to_vec(),
            decorators: vec![],
            span: DUMMY_SP,
            ctxt: Default::default(),
            body: Some(BlockStmt {
                span: DUMMY_SP,
                stmts,
                ctxt: Default::default(),
            }),
            is_generator,
            is_async,
            type_params: None,
            return_type: None,
        }),
    });
    match cm {
        Some(cm) => emit_expr_with_source_map(&fn_expr, cm, location),
        None => (
            emit_expr_str(&fn_expr, &Lrc::new(SourceMap::default())),
            None,
        ),
    }
}

fn make_closure_destruct_stmt(cv: &[Ident]) -> Stmt {
    Stmt::Decl(Decl::Var(Box::new(VarDecl {
        span: DUMMY_SP,
        ctxt: Default::default(),
        kind: VarDeclKind::Const,
        declare: false,
        decls: vec![VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Object(ObjectPat {
                span: DUMMY_SP,
                props: cv
                    .iter()
                    .map(|v| {
                        ObjectPatProp::Assign(AssignPatProp {
                            span: DUMMY_SP,
                            key: BindingIdent {
                                id: make_ident(v.sym.as_ref()),
                                type_ann: None,
                            },
                            value: None,
                        })
                    })
                    .collect(),
                optional: false,
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Member(MemberExpr {
                span: DUMMY_SP,
                obj: Box::new(Expr::This(ThisExpr { span: DUMMY_SP })),
                prop: MemberProp::Ident(IdentName::new("__closure".into(), DUMMY_SP)),
            }))),
            definite: false,
        }],
    })))
}

pub fn emit_expr_str(expr: &Expr, cm: &Lrc<SourceMap>) -> String {
    let module = Module {
        span: DUMMY_SP,
        body: vec![ModuleItem::Stmt(Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(expr.clone()),
        }))],
        shebang: None,
    };
    let mut buf: Vec<u8> = vec![];
    {
        let wr = JsWriter::new(cm.clone(), "\n", &mut buf, None);
        let mut emitter = Emitter {
            cfg: EmitConfig::default(),
            cm: cm.clone(),
            comments: None,
            wr,
        };
        emitter.emit_module(&module).ok();
    }
    let s = unsafe { String::from_utf8_unchecked(buf) };
    s.trim_end_matches([';', '\n', '\r', ' ']).to_string()
}

/// Emit `expr` and capture a source map tracking the original positions of
/// copied AST nodes (synthesized nodes with `DUMMY_SP` are skipped by the
/// source map builder). Returns the trimmed code string and the source map
/// serialized as JSON.
///
/// The output source map lists exactly one `sources` entry (the worklet's
/// own `location`) so downstream consumers (Hermes, devtools) can resolve
/// line/column mappings without needing the original bundle.
fn emit_expr_with_source_map(
    expr: &Expr,
    cm: &Lrc<SourceMap>,
    location: &str,
) -> (String, Option<String>) {
    let module = Module {
        span: DUMMY_SP,
        body: vec![ModuleItem::Stmt(Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(expr.clone()),
        }))],
        shebang: None,
    };
    let mut buf: Vec<u8> = vec![];
    let mut mappings: Vec<(BytePos, LineCol)> = vec![];
    {
        let wr = JsWriter::new(cm.clone(), "\n", &mut buf, Some(&mut mappings));
        let mut emitter = Emitter {
            cfg: EmitConfig::default(),
            cm: cm.clone(),
            comments: None,
            wr,
        };
        emitter.emit_module(&module).ok();
    }
    let code = unsafe { String::from_utf8_unchecked(buf) };
    let code = code.trim_end_matches([';', '\n', '\r', ' ']).to_string();

    let sm_json = if mappings.is_empty() {
        None
    } else {
        let config = WorkletSourceMapConfig {
            override_source: if location.is_empty() {
                None
            } else {
                Some(location.to_string())
            },
        };
        let sm = cm.build_source_map(&mappings, None, config);
        let mut sm_buf: Vec<u8> = vec![];
        sm.to_writer(&mut sm_buf)
            .ok()
            .and_then(|()| String::from_utf8(sm_buf).ok())
    };

    (code, sm_json)
}

/// Source map config that pins the single `sources` entry to the worklet's
/// original location (or lets SWC's default derive it from the `FileName`
/// when no override is given). Inline source content is disabled — the
/// emitted map stays compact and relies on the bundler's source file.
struct WorkletSourceMapConfig {
    override_source: Option<String>,
}

impl swc_core::common::source_map::SourceMapGenConfig for WorkletSourceMapConfig {
    fn file_name_to_source(&self, f: &swc_core::common::FileName) -> String {
        if let Some(ref s) = self.override_source {
            return s.clone();
        }
        DefaultSourceMapGenConfig.file_name_to_source(f)
    }

    fn inline_sources_content(&self, _f: &swc_core::common::FileName) -> bool {
        false
    }
}

pub fn emit_program(program: &Program) -> String {
    let cm = Lrc::new(SourceMap::default());
    let mut buf: Vec<u8> = vec![];
    {
        let wr = JsWriter::new(cm.clone(), "\n", &mut buf, None);
        let mut emitter = Emitter {
            cfg: EmitConfig::default(),
            cm: cm.clone(),
            comments: None,
            wr,
        };
        match program {
            Program::Module(m) => emitter.emit_module(m).ok(),
            Program::Script(s) => emitter.emit_script(s).ok(),
        };
    }
    unsafe { String::from_utf8_unchecked(buf) }
}
