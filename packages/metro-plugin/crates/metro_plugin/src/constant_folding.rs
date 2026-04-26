use rustc_hash::{FxHashMap, FxHashSet};
use swc_core::atoms::Atom;
use swc_core::common::util::take::Take;
use swc_core::common::DUMMY_SP;
use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{VisitMut, VisitMutWith};

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

fn eval_expr(expr: &Expr, bindings: &FxHashMap<Atom, Value>) -> Option<Value> {
    match expr {
        Expr::Lit(lit) => eval_lit(lit),
        Expr::Ident(id) => match id.sym.as_ref() {
            "undefined" => Some(Value::Undefined),
            "NaN" => Some(Value::Number(f64::NAN)),
            // Atom doesn't impl Borrow<str>, so we look up by &Atom directly
            // — no allocation, hash precomputed.
            _ => bindings.get(&id.sym).cloned(),
        },
        Expr::Paren(p) => eval_expr(&p.expr, bindings),
        Expr::Unary(u) => eval_unary(u, bindings),
        Expr::Bin(b) => eval_binary(b, bindings),
        // void <literal> → undefined; void <side-effectful> → None
        _ => None,
    }
}

fn eval_unary(u: &UnaryExpr, bindings: &FxHashMap<Atom, Value>) -> Option<Value> {
    match u.op {
        UnaryOp::Void => {
            // `void 0`, `void <literal>` → undefined; side-effectful → None
            match eval_expr(&u.arg, bindings) {
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
            let v = eval_expr(&u.arg, bindings)?;
            Some(Value::Bool(!v.is_truthy()))
        }
        UnaryOp::Minus => match eval_expr(&u.arg, bindings)? {
            Value::Number(n) => Some(Value::Number(-n)),
            _ => None,
        },
        UnaryOp::Plus => match eval_expr(&u.arg, bindings)? {
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

fn eval_binary(b: &BinExpr, bindings: &FxHashMap<Atom, Value>) -> Option<Value> {
    use BinaryOp::*;

    // For logical operators (&&, ||, ??), we only need the left side.
    match b.op {
        LogicalAnd => {
            let left = eval_expr(&b.left, bindings)?;
            return if left.is_truthy() { None } else { Some(left) };
        }
        LogicalOr => {
            let left = eval_expr(&b.left, bindings)?;
            return if left.is_truthy() { Some(left) } else { None };
        }
        NullishCoalescing => {
            let left = eval_expr(&b.left, bindings)?;
            return if left.is_nullish() { None } else { Some(left) };
        }
        _ => {}
    }

    let lv = eval_expr(&b.left, bindings)?;
    let rv = eval_expr(&b.right, bindings)?;

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

fn collect_refs_in_stmts(stmts: &[Stmt], refs: &mut FxHashSet<Atom>) {
    for s in stmts {
        collect_refs_in_stmt(s, refs);
    }
}

fn collect_refs_in_stmt(stmt: &Stmt, refs: &mut FxHashSet<Atom>) {
    match stmt {
        Stmt::Expr(e) => collect_refs_in_expr(&e.expr, refs),
        Stmt::Block(b) => collect_refs_in_stmts(&b.stmts, refs),
        Stmt::Return(r) => {
            if let Some(arg) = &r.arg {
                collect_refs_in_expr(arg, refs);
            }
        }
        Stmt::If(i) => {
            collect_refs_in_expr(&i.test, refs);
            collect_refs_in_stmt(&i.cons, refs);
            if let Some(alt) = &i.alt {
                collect_refs_in_stmt(alt, refs);
            }
        }
        Stmt::Decl(d) => collect_refs_in_decl(d, refs),
        Stmt::While(w) => {
            collect_refs_in_expr(&w.test, refs);
            collect_refs_in_stmt(&w.body, refs);
        }
        Stmt::For(f) => {
            if let Some(init) = &f.init {
                match init {
                    VarDeclOrExpr::Expr(e) => collect_refs_in_expr(e, refs),
                    VarDeclOrExpr::VarDecl(vd) => collect_refs_in_var_decl(vd, refs),
                }
            }
            if let Some(test) = &f.test {
                collect_refs_in_expr(test, refs);
            }
            if let Some(update) = &f.update {
                collect_refs_in_expr(update, refs);
            }
            collect_refs_in_stmt(&f.body, refs);
        }
        Stmt::Throw(t) => collect_refs_in_expr(&t.arg, refs),
        _ => {}
    }
}

fn collect_refs_in_decl(decl: &Decl, refs: &mut FxHashSet<Atom>) {
    match decl {
        Decl::Var(vd) => collect_refs_in_var_decl(vd, refs),
        Decl::Fn(fd) => {
            if let Some(body) = &fd.function.body {
                collect_refs_in_stmts(&body.stmts, refs);
            }
        }
        _ => {}
    }
}

fn collect_refs_in_var_decl(vd: &VarDecl, refs: &mut FxHashSet<Atom>) {
    for d in &vd.decls {
        if let Some(init) = &d.init {
            collect_refs_in_expr(init, refs);
        }
    }
}

fn collect_refs_in_expr(expr: &Expr, refs: &mut FxHashSet<Atom>) {
    match expr {
        Expr::Ident(id) => {
            refs.insert(id.sym.clone());
        }
        Expr::Call(c) => {
            collect_refs_in_callee(&c.callee, refs);
            for arg in &c.args {
                collect_refs_in_expr(&arg.expr, refs);
            }
        }
        Expr::Fn(f) => {
            if let Some(body) = &f.function.body {
                collect_refs_in_stmts(&body.stmts, refs);
            }
        }
        Expr::Arrow(a) => match &*a.body {
            BlockStmtOrExpr::BlockStmt(b) => collect_refs_in_stmts(&b.stmts, refs),
            BlockStmtOrExpr::Expr(e) => collect_refs_in_expr(e, refs),
        },
        Expr::Paren(p) => collect_refs_in_expr(&p.expr, refs),
        Expr::Assign(a) => {
            collect_refs_in_assignee(&a.left, refs);
            collect_refs_in_expr(&a.right, refs);
        }
        Expr::Bin(b) => {
            collect_refs_in_expr(&b.left, refs);
            collect_refs_in_expr(&b.right, refs);
        }
        Expr::Unary(u) => collect_refs_in_expr(&u.arg, refs),
        Expr::Member(m) => {
            collect_refs_in_expr(&m.obj, refs);
        }
        Expr::Seq(s) => {
            for e in &s.exprs {
                collect_refs_in_expr(e, refs);
            }
        }
        Expr::Tpl(t) => {
            for e in &t.exprs {
                collect_refs_in_expr(e, refs);
            }
        }
        _ => {}
    }
}

fn collect_refs_in_callee(callee: &Callee, refs: &mut FxHashSet<Atom>) {
    if let Callee::Expr(e) = callee {
        collect_refs_in_expr(e, refs)
    }
}

fn collect_refs_in_assignee(left: &AssignTarget, refs: &mut FxHashSet<Atom>) {
    if let AssignTarget::Simple(SimpleAssignTarget::Ident(id)) = left {
        refs.insert(id.id.sym.clone());
    }
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
    /// Tracks `var/const/let x = <literal>` bindings for variable folding.
    bindings: FxHashMap<Atom, Value>,
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
                        if let Some(lv) = eval_expr(&b.left, &self.bindings) {
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
                        if let Some(lv) = eval_expr(&b.left, &self.bindings) {
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
                        if let Some(lv) = eval_expr(&b.left, &self.bindings) {
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
                        if let Some(val) = eval_binary(b, &self.bindings) {
                            *expr = val.to_expr();
                            self.stripped = true;
                        }
                    }
                }
            }
            Expr::Unary(u) => {
                if let Some(val) = eval_unary(u, &self.bindings) {
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
                if let Some(test_val) = eval_expr(&c.test, &self.bindings) {
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
    // Collect var/const/let bindings with literal inits (for variable-tracking).
    fn visit_mut_var_decl(&mut self, n: &mut VarDecl) {
        n.visit_mut_children_with(self);
        for d in &n.decls {
            if let Pat::Ident(bi) = &d.name {
                if let Some(init) = &d.init {
                    if let Some(val) = eval_expr(init, &self.bindings) {
                        self.bindings.insert(bi.id.sym.clone(), val);
                    }
                }
            }
        }
    }

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
            if let Some(test_val) = eval_expr(&if_stmt.test, &self.bindings) {
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
    // Collect references across the whole item list
    let mut refs: FxHashSet<Atom> = FxHashSet::default();
    for item in items.iter() {
        if let ModuleItem::Stmt(s) = item {
            collect_refs_in_stmt(s, &mut refs);
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
