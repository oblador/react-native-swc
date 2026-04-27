use rustc_hash::FxHashSet;
use swc_core::atoms::Atom;
use swc_core::common::util::take::Take;
use swc_core::common::DUMMY_SP;
use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{Visit, VisitMut, VisitMutWith, VisitWith};

// ---------------------------------------------------------------------------
// Evaluated value
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum Value {
    Number(f64),
    Str(String),
    Bool(bool),
    Null,
    Undefined,
}

impl Value {
    fn is_truthy(&self) -> bool {
        match self {
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::Str(s) => !s.is_empty(),
            Value::Null | Value::Undefined => false,
        }
    }

    fn is_nullish(&self) -> bool {
        matches!(self, Value::Null | Value::Undefined)
    }

    /// Convert back to an AST expression literal.
    fn to_expr(&self) -> Expr {
        match self {
            Value::Bool(b) => Expr::Lit(Lit::Bool(Bool {
                span: DUMMY_SP,
                value: *b,
            })),
            Value::Number(n) => {
                if n.is_sign_negative() && *n != 0.0_f64 {
                    // e.g. -1  →  UnaryExpr(-, 1)
                    Expr::Unary(UnaryExpr {
                        span: DUMMY_SP,
                        op: UnaryOp::Minus,
                        arg: Box::new(Expr::Lit(Lit::Num(Number {
                            span: DUMMY_SP,
                            value: n.abs(),
                            raw: None,
                        }))),
                    })
                } else {
                    Expr::Lit(Lit::Num(Number {
                        span: DUMMY_SP,
                        value: *n,
                        raw: None,
                    }))
                }
            }
            Value::Str(s) => Expr::Lit(Lit::Str(Str {
                span: DUMMY_SP,
                value: Atom::from(s.as_str()).into(),
                raw: None,
            })),
            Value::Null => Expr::Lit(Lit::Null(Null { span: DUMMY_SP })),
            Value::Undefined => Expr::Ident(Ident::new(
                Atom::new("undefined"),
                DUMMY_SP,
                Default::default(),
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// Expression evaluator
// ---------------------------------------------------------------------------

fn eval_lit(lit: &Lit) -> Option<Value> {
    match lit {
        Lit::Bool(b) => Some(Value::Bool(b.value)),
        Lit::Num(n) => Some(Value::Number(n.value)),
        Lit::Str(s) => Some(Value::Str(s.value.to_string_lossy().into_owned())),
        Lit::Null(_) => Some(Value::Null),
        _ => None,
    }
}

/// Evaluate `expr` to a literal `Value`, returning `None` if the expression
/// contains anything we can't statically reduce.
///
/// Identifier references — `var`/`let`/`const` bindings — are NOT evaluated.
/// A previous version of this pass tracked them in a process-global hashmap
/// without scope or use-def analysis, which miscompiled real code: an inner
/// `var TotalLanes = <huge>` in one function leaked out and got folded into
/// another function's `i < TotalLanes` loop test, producing infinite loops
/// and multi-hundred-million-element array allocations in React's production
/// build. Babel-style scope-aware `path.evaluate()` would be the correct
/// fix; until then, this pass leans on the SWC `optimizer.globals` pass
/// (which runs before us and inlines `__DEV__` / `process.env.NODE_ENV`
/// directly into expressions) plus the minifier afterwards.
fn eval_expr(expr: &Expr) -> Option<Value> {
    match expr {
        Expr::Lit(lit) => eval_lit(lit),
        Expr::Ident(id) => match id.sym.as_ref() {
            "undefined" => Some(Value::Undefined),
            "NaN" => Some(Value::Number(f64::NAN)),
            _ => None,
        },
        Expr::Paren(p) => eval_expr(&p.expr),
        Expr::Unary(u) => eval_unary(u),
        Expr::Bin(b) => eval_binary(b),
        _ => None,
    }
}

fn eval_unary(u: &UnaryExpr) -> Option<Value> {
    match u.op {
        UnaryOp::Void => {
            // `void 0`, `void <literal>` → undefined; side-effectful → None
            match eval_expr(&u.arg) {
                Some(_) => {
                    // only safe to fold if the arg has no side effects
                    if is_pure(&u.arg) {
                        Some(Value::Undefined)
                    } else {
                        None
                    }
                }
                None => None,
            }
        }
        UnaryOp::Bang => {
            let v = eval_expr(&u.arg)?;
            Some(Value::Bool(!v.is_truthy()))
        }
        UnaryOp::Minus => match eval_expr(&u.arg)? {
            Value::Number(n) => Some(Value::Number(-n)),
            _ => None,
        },
        UnaryOp::Plus => match eval_expr(&u.arg)? {
            Value::Number(n) => Some(Value::Number(n)),
            _ => None,
        },
        _ => None,
    }
}

/// Returns true if evaluating `expr` can have no side effects.
fn is_pure(expr: &Expr) -> bool {
    match expr {
        Expr::Lit(_) => true,
        Expr::Ident(_) => true,
        Expr::Paren(p) => is_pure(&p.expr),
        Expr::Unary(u) => is_pure(&u.arg),
        Expr::Bin(b) => is_pure(&b.left) && is_pure(&b.right),
        _ => false,
    }
}

fn eval_binary(b: &BinExpr) -> Option<Value> {
    use BinaryOp::*;

    // For logical operators (&&, ||, ??), we only need the left side.
    match b.op {
        LogicalAnd => {
            let left = eval_expr(&b.left)?;
            return if left.is_truthy() { None } else { Some(left) };
        }
        LogicalOr => {
            let left = eval_expr(&b.left)?;
            return if left.is_truthy() { Some(left) } else { None };
        }
        NullishCoalescing => {
            let left = eval_expr(&b.left)?;
            return if left.is_nullish() { None } else { Some(left) };
        }
        _ => {}
    }

    let lv = eval_expr(&b.left)?;
    let rv = eval_expr(&b.right)?;

    match b.op {
        EqEq => Some(Value::Bool(loose_eq(&lv, &rv))),
        NotEq => Some(Value::Bool(!loose_eq(&lv, &rv))),
        EqEqEq => Some(Value::Bool(strict_eq(&lv, &rv))),
        NotEqEq => Some(Value::Bool(!strict_eq(&lv, &rv))),
        Lt => num_cmp(&lv, &rv, |a, b| a < b),
        LtEq => num_cmp(&lv, &rv, |a, b| a <= b),
        Gt => num_cmp(&lv, &rv, |a, b| a > b),
        GtEq => num_cmp(&lv, &rv, |a, b| a >= b),
        Add => match (&lv, &rv) {
            (Value::Number(a), Value::Number(b)) => Some(Value::Number(a + b)),
            (Value::Str(a), Value::Str(b)) => Some(Value::Str(format!("{a}{b}"))),
            (Value::Number(a), Value::Str(b)) => Some(Value::Str(format!("{a}{b}"))),
            (Value::Str(a), Value::Number(b)) => Some(Value::Str(format!("{a}{b}"))),
            _ => None,
        },
        Sub => match (&lv, &rv) {
            (Value::Number(a), Value::Number(b)) => Some(Value::Number(a - b)),
            _ => None,
        },
        Mul => match (&lv, &rv) {
            (Value::Number(a), Value::Number(b)) => Some(Value::Number(a * b)),
            _ => None,
        },
        Div => match (&lv, &rv) {
            (Value::Number(a), Value::Number(b)) => {
                if *b == 0.0 {
                    None
                } else {
                    Some(Value::Number(a / b))
                }
            }
            _ => None,
        },
        _ => None,
    }
}

fn loose_eq(a: &Value, b: &Value) -> bool {
    // Simplified loose equality (enough for the Metro test cases)
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) | (Value::Undefined, Value::Undefined) => true,
        (Value::Null, Value::Undefined) | (Value::Undefined, Value::Null) => true,
        // String == Number: coerce string to number
        (Value::Str(s), Value::Number(n)) | (Value::Number(n), Value::Str(s)) => {
            s.parse::<f64>().ok() == Some(*n)
        }
        _ => false,
    }
}

fn strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) => true,
        (Value::Undefined, Value::Undefined) => true,
        _ => false,
    }
}

fn num_cmp(a: &Value, b: &Value, f: impl Fn(f64, f64) -> bool) -> Option<Value> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => Some(Value::Bool(f(*x, *y))),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Dead-code / unused-function helpers
// ---------------------------------------------------------------------------
//
// `RefCollector` is a comprehensive identifier visitor used by the
// unused-function pass below. The earlier hand-rolled walk only handled a
// curated subset of expression shapes (`Expr::Bin`, `Expr::Call`, `Expr::Tpl`,
// …) and silently skipped everything else — most importantly `Expr::Object`,
// which made `function f() {}` look unreferenced when its only call sites lived
// inside an object literal (e.g. `global.console = { error: f() }`). Instead of
// chasing each missing variant, defer to SWC's `Visit` traversal and only
// suppress contexts where an `Ident` is NOT a reference: member-access
// property names, object/class property keys, and crucially binding sites
// (declaration names, parameter names, var declarator names — patterns).
//
// Over-approximation is safe (we only ever remove a function when it has
// zero collected references); under-approximation is not — missing a real
// reference would silently delete code, which is exactly the bug this
// rewrite is fixing.
struct RefCollector<'a> {
    refs: &'a mut FxHashSet<Atom>,
}

impl RefCollector<'_> {
    /// Walk a binding pattern, descending only into reference-bearing
    /// sub-positions: default values (`{a = expr}`, `[a = expr]`, `x = expr`),
    /// computed property keys, and assignment-target expressions. Pattern
    /// idents themselves are bindings and skipped.
    fn visit_pat_refs(&mut self, pat: &Pat) {
        match pat {
            Pat::Ident(_) | Pat::Invalid(_) => {}
            Pat::Array(a) => {
                for elem in a.elems.iter().flatten() {
                    self.visit_pat_refs(elem);
                }
            }
            Pat::Object(o) => {
                for prop in &o.props {
                    match prop {
                        ObjectPatProp::KeyValue(kv) => {
                            if let PropName::Computed(c) = &kv.key {
                                c.expr.visit_with(self);
                            }
                            self.visit_pat_refs(&kv.value);
                        }
                        ObjectPatProp::Assign(a) => {
                            if let Some(value) = &a.value {
                                value.visit_with(self);
                            }
                        }
                        ObjectPatProp::Rest(r) => self.visit_pat_refs(&r.arg),
                    }
                }
            }
            Pat::Rest(r) => self.visit_pat_refs(&r.arg),
            Pat::Assign(a) => {
                self.visit_pat_refs(&a.left);
                a.right.visit_with(self);
            }
            // `Pat::Expr` only appears in assignment-target positions
            // (`[obj.foo] = …`); its content IS a reference.
            Pat::Expr(e) => e.visit_with(self),
        }
    }
}

impl Visit for RefCollector<'_> {
    fn visit_ident(&mut self, n: &Ident) {
        self.refs.insert(n.sym.clone());
    }

    // ---- Binding sites: skip the binding ident, walk other sub-nodes ----

    fn visit_fn_decl(&mut self, n: &FnDecl) {
        n.function.visit_with(self);
    }

    fn visit_class_decl(&mut self, n: &ClassDecl) {
        n.class.visit_with(self);
    }

    // FnExpr's optional name binds inside its own body for self-reference;
    // for unused-function analysis we only care about references from
    // *outside* the function, so the FnExpr ident is treated as a binding.
    fn visit_fn_expr(&mut self, n: &FnExpr) {
        n.function.visit_with(self);
    }

    fn visit_class_expr(&mut self, n: &ClassExpr) {
        n.class.visit_with(self);
    }

    fn visit_var_declarator(&mut self, n: &VarDeclarator) {
        self.visit_pat_refs(&n.name);
        if let Some(init) = &n.init {
            init.visit_with(self);
        }
    }

    fn visit_param(&mut self, n: &Param) {
        for d in &n.decorators {
            d.visit_with(self);
        }
        self.visit_pat_refs(&n.pat);
    }

    fn visit_arrow_expr(&mut self, n: &ArrowExpr) {
        for p in &n.params {
            self.visit_pat_refs(p);
        }
        n.body.visit_with(self);
    }

    fn visit_catch_clause(&mut self, n: &CatchClause) {
        if let Some(param) = &n.param {
            self.visit_pat_refs(param);
        }
        n.body.visit_with(self);
    }

    fn visit_for_in_stmt(&mut self, n: &ForInStmt) {
        self.visit_for_head(&n.left);
        n.right.visit_with(self);
        n.body.visit_with(self);
    }

    fn visit_for_of_stmt(&mut self, n: &ForOfStmt) {
        self.visit_for_head(&n.left);
        n.right.visit_with(self);
        n.body.visit_with(self);
    }

    // Import bindings are declarations — skip the local idents.
    fn visit_import_decl(&mut self, _: &ImportDecl) {}

    // Export-as renames: only the *referenced* identifier matters.
    fn visit_export_named_specifier(&mut self, n: &ExportNamedSpecifier) {
        if let ModuleExportName::Ident(id) = &n.orig {
            self.refs.insert(id.sym.clone());
        }
    }

    // ---- Property names ARE NOT references ----

    fn visit_member_expr(&mut self, n: &MemberExpr) {
        n.obj.visit_with(self);
        if let MemberProp::Computed(c) = &n.prop {
            c.expr.visit_with(self);
        }
    }

    fn visit_super_prop_expr(&mut self, n: &SuperPropExpr) {
        if let SuperProp::Computed(c) = &n.prop {
            c.expr.visit_with(self);
        }
    }

    fn visit_prop(&mut self, n: &Prop) {
        match n {
            // `{foo}` desugars to `{foo: foo}` — the value IS a reference.
            Prop::Shorthand(id) => {
                self.refs.insert(id.sym.clone());
            }
            Prop::KeyValue(kv) => {
                if let PropName::Computed(c) = &kv.key {
                    c.expr.visit_with(self);
                }
                kv.value.visit_with(self);
            }
            Prop::Assign(a) => {
                a.value.visit_with(self);
            }
            Prop::Getter(g) => {
                if let PropName::Computed(c) = &g.key {
                    c.expr.visit_with(self);
                }
                g.body.visit_with(self);
            }
            Prop::Setter(s) => {
                if let PropName::Computed(c) = &s.key {
                    c.expr.visit_with(self);
                }
                self.visit_pat_refs(&s.param);
                s.body.visit_with(self);
            }
            Prop::Method(m) => {
                if let PropName::Computed(c) = &m.key {
                    c.expr.visit_with(self);
                }
                m.function.visit_with(self);
            }
        }
    }

    fn visit_class_member(&mut self, n: &ClassMember) {
        match n {
            ClassMember::Method(m) => {
                if let PropName::Computed(c) = &m.key {
                    c.expr.visit_with(self);
                }
                m.function.visit_with(self);
            }
            ClassMember::PrivateMethod(m) => m.function.visit_with(self),
            ClassMember::ClassProp(p) => {
                if let PropName::Computed(c) = &p.key {
                    c.expr.visit_with(self);
                }
                if let Some(value) = &p.value {
                    value.visit_with(self);
                }
            }
            ClassMember::PrivateProp(p) => {
                if let Some(value) = &p.value {
                    value.visit_with(self);
                }
            }
            ClassMember::AutoAccessor(a) => {
                if let Key::Public(PropName::Computed(c)) = &a.key {
                    c.expr.visit_with(self);
                }
                if let Some(value) = &a.value {
                    value.visit_with(self);
                }
            }
            _ => n.visit_children_with(self),
        }
    }

    fn visit_jsx_attr(&mut self, n: &JSXAttr) {
        if let Some(v) = &n.value {
            v.visit_with(self);
        }
    }
}

impl RefCollector<'_> {
    fn visit_for_head(&mut self, head: &ForHead) {
        match head {
            ForHead::VarDecl(vd) => {
                for d in &vd.decls {
                    self.visit_pat_refs(&d.name);
                    if let Some(init) = &d.init {
                        init.visit_with(self);
                    }
                }
            }
            ForHead::Pat(p) => self.visit_pat_refs(p),
            ForHead::UsingDecl(u) => {
                for d in &u.decls {
                    self.visit_pat_refs(&d.name);
                    if let Some(init) = &d.init {
                        init.visit_with(self);
                    }
                }
            }
        }
    }
}

fn collect_refs_in_stmt(stmt: &Stmt, refs: &mut FxHashSet<Atom>) {
    let mut c = RefCollector { refs };
    stmt.visit_with(&mut c);
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/// Perform constant folding on `program`. Loops until no more changes are made.
///
/// Mirrors Metro's `constant-folding-plugin.js`.
pub fn constant_folding(program: &mut Program) {
    loop {
        let mut folder = ConstantFolder::default();
        program.visit_mut_with(&mut folder);
        if !folder.stripped {
            break;
        }
    }
}

#[derive(Default)]
struct ConstantFolder {
    /// Set to true whenever a change is made (drives the outer loop).
    stripped: bool,
}

impl ConstantFolder {
    fn try_fold_expr(&mut self, expr: &mut Expr) {
        match expr {
            // Unwrap parentheses around simple (already-folded) expressions.
            Expr::Paren(p) => {
                let should_unwrap =
                    matches!(*p.expr, Expr::Lit(_) | Expr::Ident(_) | Expr::Unary(_));
                if should_unwrap {
                    *expr = *p.expr.take();
                    self.stripped = true;
                }
            }
            // Evaluate binary and unary expressions
            Expr::Bin(b) => {
                use BinaryOp::*;
                // Special handling for logical operators (short-circuit):
                // fold when only the left side is known
                match b.op {
                    LogicalAnd => {
                        if let Some(lv) = eval_expr(&b.left) {
                            if !lv.is_truthy() {
                                // false && anything → left
                                *expr = *b.left.take();
                                self.stripped = true;
                            } else {
                                // true && right → right
                                *expr = *b.right.take();
                                self.stripped = true;
                            }
                        }
                    }
                    LogicalOr => {
                        if let Some(lv) = eval_expr(&b.left) {
                            if lv.is_truthy() {
                                // "truthy" || anything → left
                                *expr = *b.left.take();
                                self.stripped = true;
                            } else {
                                // null || right → right
                                *expr = *b.right.take();
                                self.stripped = true;
                            }
                        }
                    }
                    NullishCoalescing => {
                        if let Some(lv) = eval_expr(&b.left) {
                            if lv.is_nullish() {
                                // null ?? right → right
                                *expr = *b.right.take();
                                self.stripped = true;
                            } else {
                                // value ?? anything → left
                                *expr = *b.left.take();
                                self.stripped = true;
                            }
                        }
                    }
                    _ => {
                        // Regular binary: need both sides
                        if let Some(val) = eval_binary(b) {
                            *expr = val.to_expr();
                            self.stripped = true;
                        }
                    }
                }
            }
            Expr::Unary(u) => {
                if let Some(val) = eval_unary(u) {
                    let new_expr = val.to_expr();
                    // Only replace if we're actually simplifying — avoid infinite loops
                    // where e.g. -1 → UnaryExpr(Minus, 1) → -1 → ... forever.
                    if !matches!(new_expr, Expr::Unary(_)) {
                        *expr = new_expr;
                        self.stripped = true;
                    }
                }
            }
            Expr::Cond(c) => {
                if let Some(test_val) = eval_expr(&c.test) {
                    *expr = if test_val.is_truthy() {
                        *c.cons.take()
                    } else {
                        *c.alt.take()
                    };
                    self.stripped = true;
                }
            }
            _ => {}
        }
    }
}

impl VisitMut for ConstantFolder {
    // Fold expressions post-order: children first, then this node.
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);
        self.try_fold_expr(expr);
    }

    // Fold if-statements: if the test is constant, replace with the live branch.
    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        // Process children first (post-order)
        stmt.visit_mut_children_with(self);

        if let Stmt::If(if_stmt) = stmt {
            if let Some(test_val) = eval_expr(&if_stmt.test) {
                self.stripped = true;
                if test_val.is_truthy() {
                    *stmt = *if_stmt.cons.take();
                } else if let Some(alt) = if_stmt.alt.take() {
                    *stmt = *alt;
                } else {
                    *stmt = Stmt::Empty(EmptyStmt { span: DUMMY_SP });
                }
            }
        }
    }

    // After folding the program body, remove empty statements and
    // unreferenced functions. `visit_mut_stmts` handles this for statement
    // blocks; module tops require their own pass because SWC keeps their
    // body in `Vec<ModuleItem>` instead of `Vec<Stmt>`.
    fn visit_mut_module_items(&mut self, items: &mut Vec<ModuleItem>) {
        items.visit_mut_children_with(self);
        items.retain(|item| !matches!(item, ModuleItem::Stmt(Stmt::Empty(_))));
        remove_unreferenced_fns_from_module(items, &mut self.stripped);
    }

    fn visit_mut_stmts(&mut self, stmts: &mut Vec<Stmt>) {
        stmts.visit_mut_children_with(self);

        // Remove empty statements
        stmts.retain(|s| !matches!(s, Stmt::Empty(_)));

        remove_unreferenced_fns_from_stmts(stmts, &mut self.stripped);
    }
}

fn remove_unreferenced_fns_from_module(items: &mut Vec<ModuleItem>, stripped: &mut bool) {
    // Collect references across the whole item list — INCLUDING `ModuleDecl`
    // siblings. SWC plugins run before the ESM→CJS transform, so a top-level
    // `function foo() {}` paired with `export default foo;` shows up as
    // `Stmt::Decl(Decl::Fn)` next to a `ModuleDecl::ExportDefaultExpr` whose
    // expression is the only reference to `foo`. Walking only `Stmt` items
    // would miss that reference and silently delete the function declaration,
    // leaving the post-CJS `var _default = foo` pointing at nothing.
    let mut refs: FxHashSet<Atom> = FxHashSet::default();
    {
        let mut c = RefCollector { refs: &mut refs };
        for item in items.iter() {
            item.visit_with(&mut c);
        }
    }
    items.retain(|item| {
        match item {
            ModuleItem::Stmt(Stmt::Decl(Decl::Fn(fd))) => {
                if refs.contains(&fd.ident.sym) {
                    true
                } else {
                    *stripped = true;
                    false
                }
            }
            ModuleItem::Stmt(Stmt::Decl(Decl::Var(vd))) => {
                // Remove declarators whose assigned function is never referenced
                // (we'll filter the whole VarDecl out if all declarators gone)
                let _ = vd; // mutate below
                true // handled separately
            }
            _ => true,
        }
    });

    // Handle var declarations: remove declarators that assign unused fn exprs
    for item in items.iter_mut() {
        if let ModuleItem::Stmt(Stmt::Decl(Decl::Var(vd))) = item {
            remove_unused_fn_declarators(vd, &refs, stripped);
        }
    }
    // Drop empty VarDecls
    items.retain(|item| {
        if let ModuleItem::Stmt(Stmt::Decl(Decl::Var(vd))) = item {
            !vd.decls.is_empty()
        } else {
            true
        }
    });
}

fn remove_unreferenced_fns_from_stmts(stmts: &mut Vec<Stmt>, stripped: &mut bool) {
    let mut refs: FxHashSet<Atom> = FxHashSet::default();
    for s in stmts.iter() {
        collect_refs_in_stmt(s, &mut refs);
    }
    stmts.retain(|s| {
        if let Stmt::Decl(Decl::Fn(fd)) = s {
            if refs.contains(&fd.ident.sym) {
                true
            } else {
                *stripped = true;
                false
            }
        } else {
            true
        }
    });
    for s in stmts.iter_mut() {
        if let Stmt::Decl(Decl::Var(vd)) = s {
            remove_unused_fn_declarators(vd, &refs, stripped);
        }
    }
    stmts.retain(|s| {
        if let Stmt::Decl(Decl::Var(vd)) = s {
            !vd.decls.is_empty()
        } else {
            true
        }
    });
}

fn remove_unused_fn_declarators(vd: &mut VarDecl, refs: &FxHashSet<Atom>, stripped: &mut bool) {
    vd.decls.retain(|d| {
        let name: &Atom = match &d.name {
            Pat::Ident(bi) => &bi.id.sym,
            _ => return true,
        };
        let init_is_fn = d
            .init
            .as_deref()
            .is_some_and(|e| matches!(e, Expr::Fn(_) | Expr::Arrow(_)));
        if init_is_fn && !refs.contains(name) {
            *stripped = true;
            false
        } else {
            true
        }
    });
}
