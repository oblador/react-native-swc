use rustc_hash::{FxHashMap, FxHashSet};
use swc_core::atoms::Atom;
use swc_core::common::DUMMY_SP;
use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{VisitMut, VisitMutWith};

pub struct Options {
    pub inline_platform: bool,
    pub is_wrapped: bool,
    pub require_name: String,
    pub platform: String,
}

/// Apply inline replacements: __DEV__, Platform.OS, Platform.select, process.env.NODE_ENV.
/// Mirrors Metro's `inline-plugin.js`.
pub fn inline_plugin(program: &mut Program, opts: &Options) {
    let top_level_bindings = scan_top_level_bindings(program, opts);

    // Seed the outermost scope with any top-level `function <name>()`
    // declarations. A module-scope `function __DEV__() { ... }` shadows the
    // global `__DEV__` constant at every use site (including inside nested
    // functions), so `is_locally_shadowed` must see it.
    let mut scope0: FxHashSet<Atom> = FxHashSet::default();
    collect_top_level_fn_shadows(program, opts, &mut scope0);

    let mut visitor = InlineVisitor {
        opts,
        top_level_bindings,
        local_scopes: vec![scope0],
        fn_depth: 0,
    };
    program.visit_mut_with(&mut visitor);
}

/// Collect names of top-level `function <name>()` declarations (and, in
/// wrapped-module mode, `function <name>()` inside the wrapper's body) so
/// they can be treated as program-level shadows.
fn collect_top_level_fn_shadows(program: &Program, opts: &Options, out: &mut FxHashSet<Atom>) {
    let stmts: Vec<&Stmt> = match program {
        Program::Module(m) => m
            .body
            .iter()
            .filter_map(|item| {
                if let ModuleItem::Stmt(s) = item {
                    Some(s)
                } else {
                    None
                }
            })
            .collect(),
        Program::Script(s) => s.body.iter().collect(),
    };

    let inner_stmts: Vec<&Stmt> = if opts.is_wrapped {
        wrapped_inner_stmts(&stmts).unwrap_or_default()
    } else {
        vec![]
    };

    let to_scan: &[&Stmt] = if !inner_stmts.is_empty() {
        &inner_stmts
    } else {
        &stmts
    };

    for stmt in to_scan {
        if let Stmt::Decl(Decl::Fn(fd)) = stmt {
            out.insert(fd.ident.sym.clone());
        }
    }
}

/// When a module is wrapped as `__arbitrary(function(){ <body> })`, the body
/// of the first `Fn`/`Arrow` argument of the single top-level call is the
/// logical "module top". Returns the stmts of that body, if present.
fn wrapped_inner_stmts<'a>(stmts: &'a [&Stmt]) -> Option<Vec<&'a Stmt>> {
    stmts.iter().find_map(|s| {
        if let Stmt::Expr(ExprStmt { expr, .. }) = s {
            if let Expr::Call(call) = expr.as_ref() {
                for arg in &call.args {
                    match arg.expr.as_ref() {
                        Expr::Fn(f) => {
                            if let Some(body) = f.function.body.as_ref() {
                                return Some(body.stmts.iter().collect());
                            }
                        }
                        Expr::Arrow(a) => {
                            if let BlockStmtOrExpr::BlockStmt(body) = a.body.as_ref() {
                                return Some(body.stmts.iter().collect());
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        None
    })
}

// ---------------------------------------------------------------------------
// Top-level binding scan
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum TLBinding {
    PlatformModule,  // require('Platform')
    RNPlatformField, // require('react-native').Platform
    ReactModule,     // require('React')
    RNModule,        // require('react-native') or require('ReactNative')
}

fn scan_top_level_bindings(program: &Program, opts: &Options) -> FxHashMap<Atom, TLBinding> {
    let mut bindings: FxHashMap<Atom, TLBinding> = FxHashMap::default();

    let stmts: Vec<&Stmt> = match program {
        Program::Module(m) => m
            .body
            .iter()
            .filter_map(|item| {
                if let ModuleItem::Stmt(s) = item {
                    Some(s)
                } else {
                    None
                }
            })
            .collect(),
        Program::Script(s) => s.body.iter().collect(),
    };

    let inner_stmts: Vec<&Stmt> = if opts.is_wrapped {
        wrapped_inner_stmts(&stmts).unwrap_or_default()
    } else {
        vec![]
    };

    let to_scan: &[&Stmt] = if !inner_stmts.is_empty() {
        &inner_stmts
    } else {
        &stmts
    };
    for stmt in to_scan {
        if let Stmt::Decl(Decl::Var(vd)) = stmt {
            for decl in &vd.decls {
                if let Pat::Ident(bi) = &decl.name {
                    if let Some(init) = &decl.init {
                        if let Some(k) = classify_init(init.as_ref(), &opts.require_name) {
                            bindings.insert(bi.id.sym.clone(), k);
                        }
                    }
                }
            }
        }
    }

    bindings
}

fn classify_init(init: &Expr, rn: &str) -> Option<TLBinding> {
    match init {
        Expr::Call(call) => {
            if is_require_to_str(call, rn, "Platform") {
                Some(TLBinding::PlatformModule)
            } else if is_require_to_str(call, rn, "React") {
                Some(TLBinding::ReactModule)
            } else if is_require_to_str(call, rn, "react-native")
                || is_require_to_str(call, rn, "ReactNative")
            {
                Some(TLBinding::RNModule)
            } else {
                None
            }
        }
        Expr::Member(m) if is_prop_ident(&m.prop, "Platform") => {
            if let Expr::Call(call) = m.obj.as_ref() {
                if is_require_to_str(call, rn, "react-native")
                    || is_require_to_str(call, rn, "React")
                    || is_require_to_str(call, rn, "ReactNative")
                {
                    return Some(TLBinding::RNPlatformField);
                }
            }
            None
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Visitor
// ---------------------------------------------------------------------------

struct InlineVisitor<'a> {
    opts: &'a Options,
    top_level_bindings: FxHashMap<Atom, TLBinding>,
    local_scopes: Vec<FxHashSet<Atom>>,
    fn_depth: u32,
}

impl<'a> InlineVisitor<'a> {
    fn is_locally_shadowed(&self, name: &Atom) -> bool {
        self.local_scopes.iter().any(|s| s.contains(name))
    }

    fn declare_local(&mut self, name: Atom) {
        if let Some(scope) = self.local_scopes.last_mut() {
            scope.insert(name);
        }
    }

    fn push_scope(&mut self) {
        self.local_scopes.push(FxHashSet::default());
        self.fn_depth += 1;
    }

    fn pop_scope(&mut self) {
        self.local_scopes.pop();
        if self.fn_depth > 0 {
            self.fn_depth -= 1;
        }
    }

    /// Is `expr` a Platform-like value (Platform global, Platform import, require('Platform'), etc.)?
    fn is_platform_obj(&self, expr: &Expr) -> bool {
        match expr {
            Expr::Ident(id) => {
                if self.is_locally_shadowed(&id.sym) {
                    return false;
                }
                if id.sym.as_ref() == "Platform" {
                    return true;
                }
                matches!(
                    self.top_level_bindings.get(&id.sym),
                    Some(TLBinding::PlatformModule | TLBinding::RNPlatformField)
                )
            }
            Expr::Call(call) => {
                is_require_to_str(call, &self.opts.require_name, "Platform")
                    || is_require_to_str(call, &self.opts.require_name, "react-native")
            }
            // React.Platform or ReactNative.Platform or _x.Platform
            Expr::Member(m) if is_prop_ident(&m.prop, "Platform") => {
                self.is_react_or_rn_obj(&m.obj)
            }
            _ => false,
        }
    }

    fn is_react_or_rn_obj(&self, expr: &Expr) -> bool {
        match expr {
            Expr::Ident(id) => {
                if self.is_locally_shadowed(&id.sym) {
                    return false;
                }
                if matches!(id.sym.as_ref(), "React" | "ReactNative") {
                    return true;
                }
                matches!(
                    self.top_level_bindings.get(&id.sym),
                    Some(TLBinding::ReactModule | TLBinding::RNModule)
                )
            }
            Expr::Call(call) => {
                is_require_to_str(call, &self.opts.require_name, "React")
                    || is_require_to_str(call, &self.opts.require_name, "ReactNative")
                    || is_require_to_str(call, &self.opts.require_name, "react-native")
            }
            _ => false,
        }
    }

    fn try_inline(&mut self, expr: &mut Expr) -> bool {
        // Note: `__DEV__` and `process.env.NODE_ENV` are handled in
        // production by SWC's optimizer globals/envs (configured in
        // `src/swc.ts`). This pass only needs to cover the Platform
        // substitutions that the optimizer can't express.
        match expr {
            Expr::Member(member) => {
                if is_prop_ident(&member.prop, "OS")
                    && self.opts.inline_platform
                    && self.is_platform_obj(&member.obj)
                {
                    let s = self.opts.platform.clone();
                    *expr = str_lit(&s);
                    return true;
                }
                false
            }

            Expr::Call(call) => {
                if self.opts.inline_platform {
                    if let Some(r) = self.try_platform_select(call) {
                        *expr = r;
                        return true;
                    }
                }
                false
            }

            _ => false,
        }
    }

    fn try_platform_select(&self, call: &CallExpr) -> Option<Expr> {
        let callee_member = match &call.callee {
            Callee::Expr(e) => match e.as_ref() {
                Expr::Member(m) => m,
                _ => return None,
            },
            _ => return None,
        };

        if !is_prop_ident(&callee_member.prop, "select") {
            return None;
        }
        if !self.is_platform_obj(&callee_member.obj) {
            return None;
        }

        let first_arg = call.args.first()?;
        let obj = match first_arg.expr.as_ref() {
            Expr::Object(o) => o,
            _ => return None,
        };

        if !has_static_properties(obj) {
            return None;
        }

        let platform = self.opts.platform.clone();
        let result = find_property_value(obj, &platform)
            .or_else(|| find_property_value(obj, "native"))
            .or_else(|| find_property_value(obj, "default"))
            .unwrap_or_else(|| {
                Expr::Ident(Ident::new(
                    Atom::new("undefined"),
                    DUMMY_SP,
                    Default::default(),
                ))
            });

        Some(result)
    }
}

impl<'a> VisitMut for InlineVisitor<'a> {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        if self.try_inline(expr) {
            return;
        }
        expr.visit_mut_children_with(self);
    }

    fn visit_mut_function(&mut self, f: &mut Function) {
        // In wrapped-module mode, the first function entered is the module
        // wrapper — its params and directly-declared vars form the module's
        // top level, not a nested scope. Don't declare them as local or
        // Platform/etc. substitutions would be blocked.
        let is_wrapper = self.opts.is_wrapped && self.fn_depth == 0;
        self.push_scope();
        if !is_wrapper {
            for param in &f.params {
                collect_pat_atoms(&param.pat, &mut |n| self.declare_local(n.clone()));
            }
            if let Some(body) = &f.body {
                collect_var_atoms_shallow(body, &mut |n| self.declare_local(n.clone()));
            }
        }
        f.visit_mut_children_with(self);
        self.pop_scope();
    }

    fn visit_mut_arrow_expr(&mut self, f: &mut ArrowExpr) {
        let is_wrapper = self.opts.is_wrapped && self.fn_depth == 0;
        self.push_scope();
        if !is_wrapper {
            for param in &f.params {
                collect_pat_atoms(param, &mut |n| self.declare_local(n.clone()));
            }
            if let BlockStmtOrExpr::BlockStmt(body) = f.body.as_ref() {
                collect_var_atoms_shallow(body, &mut |n| self.declare_local(n.clone()));
            }
        }
        f.visit_mut_children_with(self);
        self.pop_scope();
    }

    fn visit_mut_block_stmt(&mut self, b: &mut BlockStmt) {
        let new_decls: Vec<Atom> = b
            .stmts
            .iter()
            .filter_map(|s| {
                if let Stmt::Decl(Decl::Var(vd)) = s {
                    if vd.kind != VarDeclKind::Var {
                        return Some(
                            vd.decls
                                .iter()
                                .filter_map(|d| {
                                    if let Pat::Ident(bi) = &d.name {
                                        Some(bi.id.sym.clone())
                                    } else {
                                        None
                                    }
                                })
                                .collect::<Vec<_>>(),
                        );
                    }
                }
                None
            })
            .flatten()
            .collect();

        for name in &new_decls {
            self.declare_local(name.clone());
        }
        b.visit_mut_children_with(self);
        if let Some(scope) = self.local_scopes.last_mut() {
            for name in &new_decls {
                scope.remove(name);
            }
        }
    }

    // Only visit the RHS of assignment expressions — don't replace LHS.
    fn visit_mut_assign_expr(&mut self, n: &mut AssignExpr) {
        n.right.visit_mut_with(self);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_require_to_str(call: &CallExpr, require_name: &str, module: &str) -> bool {
    let callee_ok = match &call.callee {
        Callee::Expr(e) => matches!(e.as_ref(), Expr::Ident(id) if id.sym.as_ref() == require_name),
        _ => false,
    };
    if !callee_ok || call.args.is_empty() {
        return false;
    }
    // require('module') — first arg is string
    if str_arg_eq(&call.args[0].expr, module) {
        return true;
    }
    // require(map[N], 'module') — second arg is string
    if call.args.len() >= 2 && str_arg_eq(&call.args[1].expr, module) {
        return true;
    }
    false
}

fn str_arg_eq(expr: &Expr, module: &str) -> bool {
    if let Expr::Lit(Lit::Str(s)) = expr {
        return s.value.as_atom().is_some_and(|a| a.as_ref() == module);
    }
    false
}

fn is_prop_ident(prop: &MemberProp, name: &str) -> bool {
    matches!(prop, MemberProp::Ident(id) if id.sym.as_ref() == name)
}

fn str_lit(s: &str) -> Expr {
    Expr::Lit(Lit::Str(Str {
        span: DUMMY_SP,
        value: Atom::from(s).into(),
        raw: None,
    }))
}

fn has_static_properties(obj: &ObjectLit) -> bool {
    obj.props.iter().all(|p| match p {
        PropOrSpread::Spread(_) => false,
        PropOrSpread::Prop(prop) => match prop.as_ref() {
            Prop::KeyValue(kv) => {
                matches!(&kv.key, PropName::Ident(_) | PropName::Str(_))
            }
            Prop::Method(m) => {
                // Only regular methods with static keys are allowed
                matches!(&m.key, PropName::Ident(_) | PropName::Str(_))
            }
            _ => false,
        },
    })
}

fn find_property_value(obj: &ObjectLit, key: &str) -> Option<Expr> {
    for prop in &obj.props {
        if let PropOrSpread::Prop(p) = prop {
            match p.as_ref() {
                Prop::KeyValue(kv) if prop_name_matches(&kv.key, key) => {
                    return Some(*kv.value.clone());
                }
                Prop::Method(m) if prop_name_matches(&m.key, key) => {
                    let fe = FnExpr {
                        ident: None,
                        function: m.function.clone(),
                    };
                    return Some(Expr::Fn(fe));
                }
                _ => {}
            }
        }
    }
    None
}

fn prop_name_matches(pn: &PropName, key: &str) -> bool {
    match pn {
        PropName::Ident(id) => id.sym.as_ref() == key,
        PropName::Str(s) => s.value.as_atom().is_some_and(|a| a.as_ref() == key),
        _ => false,
    }
}

fn collect_pat_atoms(pat: &Pat, emit: &mut impl FnMut(&Atom)) {
    match pat {
        Pat::Ident(bi) => emit(&bi.id.sym),
        Pat::Array(a) => {
            for el in a.elems.iter().flatten() {
                collect_pat_atoms(el, emit);
            }
        }
        Pat::Object(o) => {
            for prop in &o.props {
                match prop {
                    ObjectPatProp::Assign(a) => emit(&a.key.sym),
                    ObjectPatProp::KeyValue(kv) => collect_pat_atoms(&kv.value, emit),
                    ObjectPatProp::Rest(r) => collect_pat_atoms(&r.arg, emit),
                }
            }
        }
        Pat::Rest(r) => collect_pat_atoms(&r.arg, emit),
        Pat::Assign(a) => collect_pat_atoms(&a.left, emit),
        _ => {}
    }
}

fn collect_var_atoms_shallow(block: &BlockStmt, emit: &mut impl FnMut(&Atom)) {
    for stmt in &block.stmts {
        collect_var_in_stmt(stmt, emit);
    }
}

fn collect_var_in_stmt(stmt: &Stmt, emit: &mut impl FnMut(&Atom)) {
    match stmt {
        Stmt::Decl(Decl::Var(vd)) if vd.kind == VarDeclKind::Var => {
            for d in &vd.decls {
                collect_pat_atoms(&d.name, emit);
            }
        }
        Stmt::Block(b) => {
            for s in &b.stmts {
                collect_var_in_stmt(s, emit);
            }
        }
        Stmt::If(s) => {
            collect_var_in_stmt(&s.cons, emit);
            if let Some(alt) = &s.alt {
                collect_var_in_stmt(alt, emit);
            }
        }
        _ => {}
    }
}
