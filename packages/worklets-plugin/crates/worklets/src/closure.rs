use indexmap::{IndexMap, IndexSet};
use rustc_hash::FxHashSet;
use swc_core::atoms::Atom;
use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{Visit, VisitWith};

/// Decides whether an identifier referenced inside a worklet body should be
/// captured in the worklet's closure.
///
/// The rules mirror the Babel-based plugin's `scope.getBinding` check:
///
/// 1. Locally declared bindings (function params, body-scope `var`/`let`/`const`,
///    inner `function`/`class`, for-loop vars, catch clauses) are **not**
///    captured — they live inside the worklet.
/// 2. Otherwise, if the identifier has a binding anywhere in the module, it is
///    **always** captured (even if its name matches a default global, e.g. a
///    locally declared `console`).
/// 3. Otherwise, if `strict_global` is set, the identifier is treated as a
///    global and **not** captured.
/// 4. Otherwise, the identifier is captured unless it appears in the `globals`
///    set (default globals + user-provided custom globals).
pub struct ClosureCtx<'a> {
    pub globals: &'a FxHashSet<Atom>,
    pub file_bindings: &'a FxHashSet<Atom>,
    pub strict_global: bool,
}

/// Collect free (closure) variables of a workletizable function.
///
/// Returns one `Ident` per captured name, preserving the original
/// `SyntaxContext` from the first reference inside the body. The preserved
/// context is what lets SWC's later ESM→CJS pass correctly rewrite a
/// closure-captured imported binding (e.g. `RuntimeKind` →
/// `_modImport.RuntimeKind`) when we re-emit it in the worklet factory's
/// IIFE argument list. Losing the context (by recreating bare idents with
/// `SyntaxContext::empty()`) would leave the reference dangling at runtime.
pub fn collect_closure_vars(
    params: &[Param],
    body: &BlockStmt,
    ctx: &ClosureCtx<'_>,
) -> Vec<Ident> {
    let mut declared = IndexSet::new();
    let mut referenced = IndexMap::new();

    for param in params {
        collect_pat_bindings(&param.pat, &mut declared);
    }

    let mut decl_collector = DeclCollector {
        declared: &mut declared,
        depth: 0,
    };
    body.visit_with(&mut decl_collector);

    let mut ref_collector = RefCollector {
        declared: &declared,
        ctx,
        referenced: &mut referenced,
    };
    body.visit_with(&mut ref_collector);

    referenced.into_values().collect()
}

/// Same but for ArrowFunctionExpression with either a block or expression body.
pub fn collect_closure_vars_arrow(
    params: &[Pat],
    body: &BlockStmtOrExpr,
    ctx: &ClosureCtx<'_>,
) -> Vec<Ident> {
    let mut declared = IndexSet::new();
    let mut referenced = IndexMap::new();

    for pat in params {
        collect_pat_bindings(pat, &mut declared);
    }

    match body {
        BlockStmtOrExpr::BlockStmt(block) => {
            let mut decl_collector = DeclCollector {
                declared: &mut declared,
                depth: 0,
            };
            block.visit_with(&mut decl_collector);

            let mut ref_collector = RefCollector {
                declared: &declared,
                ctx,
                referenced: &mut referenced,
            };
            block.visit_with(&mut ref_collector);
        }
        BlockStmtOrExpr::Expr(expr) => {
            let mut ref_collector = RefCollector {
                declared: &declared,
                ctx,
                referenced: &mut referenced,
            };
            expr.visit_with(&mut ref_collector);
        }
    }

    referenced.into_values().collect()
}

pub(crate) fn collect_pat_bindings(pat: &Pat, out: &mut IndexSet<Atom>) {
    match pat {
        Pat::Ident(id) => {
            out.insert(id.id.sym.clone());
        }
        Pat::Array(arr) => {
            for elem in arr.elems.iter().flatten() {
                collect_pat_bindings(elem, out);
            }
        }
        Pat::Object(obj) => {
            for prop in &obj.props {
                match prop {
                    ObjectPatProp::KeyValue(kv) => collect_pat_bindings(&kv.value, out),
                    ObjectPatProp::Assign(a) => {
                        out.insert(a.key.sym.clone());
                    }
                    ObjectPatProp::Rest(r) => collect_pat_bindings(&r.arg, out),
                }
            }
        }
        Pat::Rest(r) => collect_pat_bindings(&r.arg, out),
        Pat::Assign(a) => collect_pat_bindings(&a.left, out),
        Pat::Expr(_) | Pat::Invalid(_) => {}
    }
}

/// Collects all declaration names within the target function scope.
/// Stops recursing into nested functions (they have their own scopes).
pub(crate) struct DeclCollector<'a> {
    pub(crate) declared: &'a mut IndexSet<Atom>,
    pub(crate) depth: usize,
}

impl Visit for DeclCollector<'_> {
    fn visit_var_declarator(&mut self, node: &VarDeclarator) {
        collect_pat_bindings(&node.name, self.declared);
        node.init.visit_with(self);
    }

    fn visit_fn_decl(&mut self, node: &FnDecl) {
        if self.depth == 0 {
            self.declared.insert(node.ident.sym.clone());
        }
    }

    fn visit_function(&mut self, node: &Function) {
        if self.depth > 0 {
            return;
        }
        let old = self.depth;
        self.depth += 1;
        let _ = node;
        self.depth = old;
    }

    fn visit_arrow_expr(&mut self, _: &ArrowExpr) {}

    fn visit_class_decl(&mut self, node: &ClassDecl) {
        if self.depth == 0 {
            self.declared.insert(node.ident.sym.clone());
        }
    }

    fn visit_catch_clause(&mut self, node: &CatchClause) {
        if let Some(param) = &node.param {
            collect_pat_bindings(param, self.declared);
        }
        node.body.visit_with(self);
    }

    fn visit_for_in_stmt(&mut self, node: &ForInStmt) {
        if let ForHead::VarDecl(decl) = &node.left {
            for d in &decl.decls {
                collect_pat_bindings(&d.name, self.declared);
            }
        }
        node.body.visit_with(self);
    }

    fn visit_for_of_stmt(&mut self, node: &ForOfStmt) {
        if let ForHead::VarDecl(decl) = &node.left {
            for d in &decl.decls {
                collect_pat_bindings(&d.name, self.declared);
            }
        }
        node.body.visit_with(self);
    }
}

/// Collects identifier references that should be captured in the closure.
struct RefCollector<'a> {
    declared: &'a IndexSet<Atom>,
    ctx: &'a ClosureCtx<'a>,
    referenced: &'a mut IndexMap<Atom, Ident>,
}

impl<'a> RefCollector<'a> {
    fn should_capture(&self, name: &Atom) -> bool {
        if self.declared.contains(name) {
            return false;
        }
        if name.as_ref() == "undefined" || name.as_ref() == "arguments" {
            return false;
        }
        // A file-level binding shadows any global of the same name, so we must
        // capture it regardless of the globals list or strict mode.
        if self.ctx.file_bindings.contains(name) {
            return true;
        }
        if self.ctx.strict_global {
            return false;
        }
        !self.ctx.globals.contains(name)
    }

    fn maybe_insert(&mut self, ident: &Ident) {
        if !self.should_capture(&ident.sym) {
            return;
        }
        self.referenced
            .entry(ident.sym.clone())
            .or_insert_with(|| ident.clone());
    }
}

impl Visit for RefCollector<'_> {
    fn visit_ident(&mut self, node: &Ident) {
        self.maybe_insert(node);
    }

    fn visit_member_expr(&mut self, node: &MemberExpr) {
        node.obj.visit_with(self);
        if let MemberProp::Computed(c) = &node.prop {
            c.expr.visit_with(self);
        }
    }

    fn visit_object_lit(&mut self, node: &ObjectLit) {
        for prop in &node.props {
            match prop {
                PropOrSpread::Prop(p) => match p.as_ref() {
                    Prop::Shorthand(id) => {
                        self.maybe_insert(id);
                    }
                    Prop::KeyValue(kv) => {
                        if let PropName::Computed(c) = &kv.key {
                            c.expr.visit_with(self);
                        }
                        kv.value.visit_with(self);
                    }
                    Prop::Method(m) => {
                        if let PropName::Computed(c) = &m.key {
                            c.expr.visit_with(self);
                        }
                        // Recurse into the method body with a fresh inner scope
                        // so that free identifiers referenced inside it are
                        // captured by the enclosing worklet's closure.
                        m.function.visit_with(self);
                    }
                    Prop::Getter(g) => {
                        if let PropName::Computed(c) = &g.key {
                            c.expr.visit_with(self);
                        }
                        if let Some(body) = &g.body {
                            let inner_declared = self.declared.clone();
                            let mut inner_ref = RefCollector {
                                declared: &inner_declared,
                                ctx: self.ctx,
                                referenced: self.referenced,
                            };
                            body.visit_with(&mut inner_ref);
                        }
                    }
                    Prop::Setter(s) => {
                        if let PropName::Computed(c) = &s.key {
                            c.expr.visit_with(self);
                        }
                        if let Some(body) = &s.body {
                            let mut inner_declared = self.declared.clone();
                            collect_pat_bindings(&s.param, &mut inner_declared);
                            let mut inner_ref = RefCollector {
                                declared: &inner_declared,
                                ctx: self.ctx,
                                referenced: self.referenced,
                            };
                            body.visit_with(&mut inner_ref);
                        }
                    }
                    Prop::Assign(a) => {
                        a.value.visit_with(self);
                    }
                },
                PropOrSpread::Spread(s) => {
                    s.expr.visit_with(self);
                }
            }
        }
    }

    fn visit_function(&mut self, node: &Function) {
        // Nested function: build the child scope and recurse.
        let mut inner_declared = self.declared.clone();
        for param in &node.params {
            collect_pat_bindings(&param.pat, &mut inner_declared);
        }
        if let Some(body) = &node.body {
            let mut inner_decl = DeclCollector {
                declared: &mut inner_declared,
                depth: 0,
            };
            body.visit_with(&mut inner_decl);
        }
        let mut inner_ref = RefCollector {
            declared: &inner_declared,
            ctx: self.ctx,
            referenced: self.referenced,
        };
        if let Some(body) = &node.body {
            body.visit_with(&mut inner_ref);
        }
    }

    fn visit_fn_expr(&mut self, node: &FnExpr) {
        // A named function expression binds its own name inside its body
        // but NOT in the enclosing scope. The default `Visit` impl would
        // visit `node.ident` as a reference via `visit_ident`, which would
        // spuriously capture the function's own name as a closure var.
        // Instead, treat the name as declared for the body and skip it at
        // the outer scope. Without this, wrapping an inner worklet in a
        // `function factoryName(param) {...}({...})` IIFE leaks
        // `factoryName` into the enclosing worklet's closure destructuring
        // — producing a `ReferenceError: Property 'factoryName' doesn't
        // exist` at runtime when the outer worklet is materialized.
        let mut inner_declared = self.declared.clone();
        if let Some(ident) = &node.ident {
            inner_declared.insert(ident.sym.clone());
        }
        for param in &node.function.params {
            collect_pat_bindings(&param.pat, &mut inner_declared);
        }
        if let Some(body) = &node.function.body {
            let mut inner_decl = DeclCollector {
                declared: &mut inner_declared,
                depth: 0,
            };
            body.visit_with(&mut inner_decl);
        }
        let mut inner_ref = RefCollector {
            declared: &inner_declared,
            ctx: self.ctx,
            referenced: self.referenced,
        };
        if let Some(body) = &node.function.body {
            body.visit_with(&mut inner_ref);
        }
    }

    fn visit_arrow_expr(&mut self, node: &ArrowExpr) {
        let mut inner_declared = self.declared.clone();
        for pat in &node.params {
            collect_pat_bindings(pat, &mut inner_declared);
        }
        match &*node.body {
            BlockStmtOrExpr::BlockStmt(block) => {
                let mut inner_decl = DeclCollector {
                    declared: &mut inner_declared,
                    depth: 0,
                };
                block.visit_with(&mut inner_decl);
                let mut inner_ref = RefCollector {
                    declared: &inner_declared,
                    ctx: self.ctx,
                    referenced: self.referenced,
                };
                block.visit_with(&mut inner_ref);
            }
            BlockStmtOrExpr::Expr(expr) => {
                let mut inner_ref = RefCollector {
                    declared: &inner_declared,
                    ctx: self.ctx,
                    referenced: self.referenced,
                };
                expr.visit_with(&mut inner_ref);
            }
        }
    }

    fn visit_ts_type(&mut self, _: &TsType) {}
    fn visit_ts_type_ann(&mut self, _: &TsTypeAnn) {}
    fn visit_ts_type_param_decl(&mut self, _: &TsTypeParamDecl) {}
    fn visit_ts_type_param_instantiation(&mut self, _: &TsTypeParamInstantiation) {}

    fn visit_key_value_prop(&mut self, node: &KeyValueProp) {
        if let PropName::Computed(c) = &node.key {
            c.expr.visit_with(self);
        }
        node.value.visit_with(self);
    }
}

/// Pre-scan a module/script and collect *all* identifier declarations across
/// every scope. Used by `ClosureCtx::file_bindings` to decide whether a
/// referenced identifier has any binding in the file (in which case it must
/// be captured, as it shadows any global of the same name).
pub fn collect_file_bindings(program: &Program) -> FxHashSet<Atom> {
    let mut out = FxHashSet::default();
    let mut v = FileBindingCollector { out: &mut out };
    program.visit_with(&mut v);
    out
}

struct FileBindingCollector<'a> {
    out: &'a mut FxHashSet<Atom>,
}

impl<'a> FileBindingCollector<'a> {
    fn push_pat(&mut self, pat: &Pat) {
        // Walk the pattern directly into our set instead of going through a
        // throwaway IndexSet — file bindings don't need ordering.
        fn walk(pat: &Pat, out: &mut FxHashSet<Atom>) {
            match pat {
                Pat::Ident(id) => {
                    out.insert(id.id.sym.clone());
                }
                Pat::Array(arr) => {
                    for elem in arr.elems.iter().flatten() {
                        walk(elem, out);
                    }
                }
                Pat::Object(obj) => {
                    for prop in &obj.props {
                        match prop {
                            ObjectPatProp::KeyValue(kv) => walk(&kv.value, out),
                            ObjectPatProp::Assign(a) => {
                                out.insert(a.key.sym.clone());
                            }
                            ObjectPatProp::Rest(r) => walk(&r.arg, out),
                        }
                    }
                }
                Pat::Rest(r) => walk(&r.arg, out),
                Pat::Assign(a) => walk(&a.left, out),
                Pat::Expr(_) | Pat::Invalid(_) => {}
            }
        }
        walk(pat, self.out);
    }
}

impl Visit for FileBindingCollector<'_> {
    fn visit_var_declarator(&mut self, n: &VarDeclarator) {
        self.push_pat(&n.name);
        n.init.visit_with(self);
    }
    fn visit_fn_decl(&mut self, n: &FnDecl) {
        self.out.insert(n.ident.sym.clone());
        n.function.visit_with(self);
    }
    fn visit_class_decl(&mut self, n: &ClassDecl) {
        self.out.insert(n.ident.sym.clone());
        n.class.visit_with(self);
    }
    fn visit_function(&mut self, n: &Function) {
        for p in &n.params {
            self.push_pat(&p.pat);
        }
        n.body.visit_with(self);
    }
    fn visit_arrow_expr(&mut self, n: &ArrowExpr) {
        for p in &n.params {
            self.push_pat(p);
        }
        n.body.visit_with(self);
    }
    fn visit_catch_clause(&mut self, n: &CatchClause) {
        if let Some(p) = &n.param {
            self.push_pat(p);
        }
        n.body.visit_with(self);
    }
    fn visit_for_in_stmt(&mut self, n: &ForInStmt) {
        if let ForHead::VarDecl(d) = &n.left {
            for dec in &d.decls {
                self.push_pat(&dec.name);
            }
        }
        n.right.visit_with(self);
        n.body.visit_with(self);
    }
    fn visit_for_of_stmt(&mut self, n: &ForOfStmt) {
        if let ForHead::VarDecl(d) = &n.left {
            for dec in &d.decls {
                self.push_pat(&dec.name);
            }
        }
        n.right.visit_with(self);
        n.body.visit_with(self);
    }
    fn visit_import_specifier(&mut self, n: &ImportSpecifier) {
        match n {
            ImportSpecifier::Named(s) => {
                self.out.insert(s.local.sym.clone());
            }
            ImportSpecifier::Default(s) => {
                self.out.insert(s.local.sym.clone());
            }
            ImportSpecifier::Namespace(s) => {
                self.out.insert(s.local.sym.clone());
            }
        }
    }
}
