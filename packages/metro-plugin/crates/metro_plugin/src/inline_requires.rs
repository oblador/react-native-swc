use rustc_hash::{FxHashMap, FxHashSet};

use swc_core::atoms::Atom;
use swc_core::common::DUMMY_SP;
use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{VisitMut, VisitMutWith};

pub struct Options {
    pub ignored_requires: Vec<String>,
    pub inlineable_calls: Vec<String>,
    pub non_memoized_modules: Vec<String>,
    pub memoize_calls: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            ignored_requires: vec![],
            inlineable_calls: vec!["require".to_string()],
            non_memoized_modules: vec![],
            memoize_calls: false,
        }
    }
}

/// Inline top-level `var X = require("module")` assignments at every usage site.
/// Mirrors Metro's `inline-requires-plugin.js`.
pub fn inline_requires(program: &mut Program, opts: &Options) {
    // The public Options struct uses Vec<String> for the WASM/JSON boundary.
    // Internally everything keys off `Atom` so AST symbol comparisons are
    // pointer/inline-bytes equality and HashMap lookups don't allocate.
    let mut inlineable_calls: FxHashSet<Atom> = FxHashSet::default();
    inlineable_calls.insert(Atom::from("require"));
    inlineable_calls.extend(opts.inlineable_calls.iter().map(|c| Atom::from(c.as_str())));

    let ignored_requires: FxHashSet<Atom> = opts
        .ignored_requires
        .iter()
        .map(|s| Atom::from(s.as_str()))
        .collect();
    let non_memoized_modules: FxHashSet<Atom> = opts
        .non_memoized_modules
        .iter()
        .map(|s| Atom::from(s.as_str()))
        .collect();

    // Pre-pass: rename nested shadowing declarations of any inlineable-call
    // name (`function require(...){}`) to `_<name>`. Upstream Metro calls
    // `scope.rename(requireFnName)` at every reference; our visitor doesn't
    // have Babel's per-reference scope operation, so we do the rename once
    // up front on every nested scope that shadows one of the inlineable
    // names. This guarantees that any `require(...)` substituted in later
    // resolves to the module-level global instead of the local shadow.
    rename_nested_shadows(program, &inlineable_calls);

    // Phase 1 + Phase 2 + Phase 3 run in a fixed-point loop so chained
    // inlining works: after `var tmp = require("./a")` is substituted away,
    // `var a = require("./a").a` becomes visible as a new candidate and
    // participates in the next iteration.
    let mut memo_hoists: FxHashSet<Atom> = FxHashSet::default();
    for _ in 0..10 {
        let candidates = collect_candidates(
            program,
            &inlineable_calls,
            &ignored_requires,
            opts.memoize_calls,
            &non_memoized_modules,
        );
        if candidates.is_empty() {
            break;
        }

        // Track names that need a hoisted `var <name>;` at the top of the
        // program (memoized candidates that were actually inlined).
        for (name, candidate) in &candidates {
            if candidate.is_memoized {
                memo_hoists.insert(name.clone());
            }
        }

        let mut replacer = InlineReplacer {
            candidates: &candidates,
            inlineable_calls: &inlineable_calls,
            local_scopes: vec![FxHashSet::default()],
            requires_shadowed: 0,
            replaced: FxHashSet::default(),
            skip: FxHashSet::default(),
            shadowed_at_ref: FxHashSet::default(),
        };
        program.visit_mut_with(&mut replacer);

        let replaced = replacer.replaced;
        let mut skip = replacer.skip;
        skip.extend(replacer.shadowed_at_ref);

        let any_change = !replaced.is_empty() || candidates.iter().any(|(n, _)| !skip.contains(n));

        remove_declarations(program, &candidates, &skip);

        if !any_change {
            break;
        }
    }

    // Prepend `var <name>;` for every memoized candidate that was hoisted.
    if !memo_hoists.is_empty() {
        hoist_memo_vars(program, &memo_hoists);
    }
}

// ---------------------------------------------------------------------------
// Candidate descriptor
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Candidate {
    /// `var X = init_expr` – the init expression to substitute at each usage.
    init: Box<Expr>,
    /// Index of the VarDeclarator inside its VarDecl stmt.
    decl_idx: usize,
    /// Index of the top-level statement that contains this declaration.
    stmt_idx: usize,
    /// When true, references are wrapped as `(name || (name = init))` and a
    /// `var name;` is hoisted to the top of the program.
    is_memoized: bool,
}

// ---------------------------------------------------------------------------
// Phase 1: collect
// ---------------------------------------------------------------------------

fn collect_candidates(
    program: &Program,
    inlineable_calls: &FxHashSet<Atom>,
    ignored_requires: &FxHashSet<Atom>,
    memoize_calls: bool,
    non_memoized_modules: &FxHashSet<Atom>,
) -> FxHashMap<Atom, Candidate> {
    let indexed_stmts: Vec<(usize, &Stmt)> = match program {
        Program::Module(m) => m
            .body
            .iter()
            .enumerate()
            .filter_map(|(i, item)| {
                if let ModuleItem::Stmt(s) = item {
                    Some((i, s))
                } else {
                    None
                }
            })
            .collect(),
        Program::Script(s) => s.body.iter().enumerate().collect(),
    };

    // Check if any inlineable call name is redeclared at the top level via a function
    // declaration. Function declarations are hoisted, so they shadow the global require.
    let top_level_shadowed: FxHashSet<Atom> = indexed_stmts
        .iter()
        .filter_map(|(_, stmt)| {
            if let Stmt::Decl(Decl::Fn(fd)) = stmt {
                if inlineable_calls.contains(&fd.ident.sym) {
                    Some(fd.ident.sym.clone())
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    // First pass: collect raw candidates without the member-assignment filter.
    // The filter requires a full extra AST walk, so we defer it until we know
    // there's at least one Member-init candidate that could be excluded.
    struct Raw<'a> {
        name: Atom,
        init: &'a Expr,
        decl_idx: usize,
        stmt_idx: usize,
        is_member_init: bool,
        is_memoized: bool,
    }
    let mut raw: Vec<Raw> = Vec::new();
    for (stmt_idx, stmt) in &indexed_stmts {
        let stmt_idx = *stmt_idx;
        if let Stmt::Decl(Decl::Var(vd)) = stmt {
            for (decl_idx, decl) in vd.decls.iter().enumerate() {
                let name: Atom = match &decl.name {
                    Pat::Ident(bi) => bi.id.sym.clone(),
                    _ => continue,
                };
                let init = match &decl.init {
                    Some(e) => e.as_ref(),
                    None => continue,
                };
                let (fn_name, module) = match get_inlineable_call(init, inlineable_calls) {
                    Some(r) => r,
                    None => continue,
                };
                if top_level_shadowed.contains(&fn_name) {
                    continue;
                }
                if let Some(m) = &module {
                    if ignored_requires.contains(m) {
                        continue;
                    }
                }
                let is_member_init = matches!(unwrap_paren(init), Expr::Member(_));
                let is_memoized = memoize_calls
                    && module
                        .as_ref()
                        .is_none_or(|m| !non_memoized_modules.contains(m));
                raw.push(Raw {
                    name,
                    init,
                    decl_idx,
                    stmt_idx,
                    is_member_init,
                    is_memoized,
                });
            }
        }
    }

    // Mirrors upstream `isExcludedMemberAssignment`: if there's any
    // `<obj>.<prop> = ...` (or `<obj>[<prop>] = ...`) in the program, a
    // candidate whose init is the same member shape is skipped. The full
    // AST walk to collect targets is only worthwhile when there's at least
    // one Member-init candidate to filter — most files have none.
    let member_assign_targets = if raw.iter().any(|r| r.is_member_init) {
        collect_member_assignment_targets(program)
    } else {
        Vec::new()
    };

    let mut out: FxHashMap<Atom, Candidate> = FxHashMap::default();
    for r in raw {
        if r.is_member_init
            && !member_assign_targets.is_empty()
            && member_assign_targets.iter().any(|t| expr_equal(t, r.init))
        {
            continue;
        }
        out.insert(
            r.name,
            Candidate {
                init: Box::new(r.init.clone()),
                decl_idx: r.decl_idx,
                stmt_idx: r.stmt_idx,
                is_memoized: r.is_memoized,
            },
        );
    }
    out
}

/// If `expr` is `fn(arg)`, `fn(arg).prop`, `(fn(arg)).prop` (paren-wrapped),
/// return `(fn_name, module_name_if_string_literal)`.
fn get_inlineable_call(
    expr: &Expr,
    inlineable_calls: &FxHashSet<Atom>,
) -> Option<(Atom, Option<Atom>)> {
    let expr = unwrap_paren(expr);
    match expr {
        Expr::Call(call) => {
            let fn_name = callee_ident_atom(call)?;
            if !inlineable_calls.contains(fn_name) {
                return None;
            }
            Some((fn_name.clone(), first_string_arg(call)))
        }
        Expr::Member(m) => {
            let obj = unwrap_paren(m.obj.as_ref());
            if let Expr::Call(call) = obj {
                let fn_name = callee_ident_atom(call)?;
                if !inlineable_calls.contains(fn_name) {
                    return None;
                }
                Some((fn_name.clone(), first_string_arg(call)))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn unwrap_paren(expr: &Expr) -> &Expr {
    let mut e = expr;
    while let Expr::Paren(p) = e {
        e = p.expr.as_ref();
    }
    e
}

fn callee_ident_atom(call: &CallExpr) -> Option<&Atom> {
    match &call.callee {
        Callee::Expr(e) => match e.as_ref() {
            Expr::Ident(id) => Some(&id.sym),
            _ => None,
        },
        _ => None,
    }
}

fn first_string_arg(call: &CallExpr) -> Option<Atom> {
    let first = call.args.first()?;
    match first.expr.as_ref() {
        // `Lit::Str.value` is a Wtf8Atom; convert through its UTF-8 view so
        // module-name comparisons against the user-supplied ignored/non-memoized
        // sets are over plain UTF-8.
        Expr::Lit(Lit::Str(s)) => Some(Atom::from(s.value.to_string_lossy().as_ref())),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Phase 2: replace references
// ---------------------------------------------------------------------------

struct InlineReplacer<'a> {
    candidates: &'a FxHashMap<Atom, Candidate>,
    inlineable_calls: &'a FxHashSet<Atom>,
    /// Stack of locally declared names per scope.
    local_scopes: Vec<FxHashSet<Atom>>,
    /// How many nested scopes have re-declared the require function.
    requires_shadowed: usize,
    /// Set of candidate names that had at least one successful replacement.
    replaced: FxHashSet<Atom>,
    /// Set of candidate names that should not be removed (reassigned).
    skip: FxHashSet<Atom>,
    /// Candidates whose name also appears as a local binding somewhere in the
    /// tree. The module-level declaration is kept for these — uses at
    /// non-shadowed sites are still inlined, but a "fallback" binding
    /// survives for references SWC's resolver may leave dangling (e.g. the
    /// Reanimated worklets plugin's ctxt-mismatched closure refs).
    shadowed_at_ref: FxHashSet<Atom>,
}

impl<'a> InlineReplacer<'a> {
    fn is_locally_shadowed(&self, name: &Atom) -> bool {
        // Skip the outermost scope (index 0 = program/module level)
        self.local_scopes.iter().skip(1).any(|s| s.contains(name))
    }

    fn declare_local(&mut self, name: Atom) {
        if let Some(scope) = self.local_scopes.last_mut() {
            scope.insert(name);
        }
    }

    fn push_scope(&mut self) {
        self.local_scopes.push(FxHashSet::default());
    }

    fn pop_scope(&mut self) {
        if let Some(leaving) = self.local_scopes.pop() {
            for name in self.inlineable_calls.iter() {
                if leaving.contains(name) {
                    self.requires_shadowed = self.requires_shadowed.saturating_sub(1);
                }
            }
        }
    }

    fn build_substitute(&self, name: &Atom, candidate: &Candidate) -> Expr {
        if candidate.is_memoized {
            // `(name || (name = init))`
            let id = Ident::new(name.clone(), DUMMY_SP, Default::default());
            let assign = Expr::Assign(AssignExpr {
                span: DUMMY_SP,
                op: op!("="),
                left: AssignTarget::Simple(SimpleAssignTarget::Ident(BindingIdent {
                    id: id.clone(),
                    type_ann: None,
                })),
                right: candidate.init.clone(),
            });
            let logical = Expr::Bin(BinExpr {
                span: DUMMY_SP,
                op: op!("||"),
                left: Box::new(Expr::Ident(id)),
                right: Box::new(Expr::Paren(ParenExpr {
                    span: DUMMY_SP,
                    expr: Box::new(assign),
                })),
            });
            Expr::Paren(ParenExpr {
                span: DUMMY_SP,
                expr: Box::new(logical),
            })
        } else {
            // Wrap in parens so `new require("m").Foo()` doesn't re-parse
            // as `(new require("m")).Foo()`. SWC's fixer removes redundant
            // parens during codegen.
            Expr::Paren(ParenExpr {
                span: DUMMY_SP,
                expr: candidate.init.clone(),
            })
        }
    }

    fn maybe_replace(&mut self, expr: &mut Expr) -> bool {
        if let Expr::Ident(id) = expr {
            // Cheap pre-check before the HashMap lookup: if no candidate
            // exists with this symbol, bail without even hashing the Atom.
            // (HashMap::get on `&Atom` is already cheap, but this gate skips
            // the hash entirely for the overwhelming majority of identifiers
            // in any real source file.)
            if !self.candidates.contains_key(&id.sym) {
                return false;
            }
            let name = id.sym.clone();
            if self.is_locally_shadowed(&name) {
                self.shadowed_at_ref.insert(name);
                return false;
            }
            if self.requires_shadowed > 0 {
                return false;
            }
            if self.skip.contains(&name) {
                return false;
            }
            let candidate = self.candidates.get(&name).expect("checked above");
            *expr = self.build_substitute(&name, candidate);
            self.replaced.insert(name);
            return true;
        }
        false
    }
}

impl<'a> VisitMut for InlineReplacer<'a> {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        if self.maybe_replace(expr) {
            return;
        }
        expr.visit_mut_children_with(self);
    }

    fn visit_mut_function(&mut self, f: &mut Function) {
        self.push_scope();
        for param in &f.params {
            collect_pat_atoms(&param.pat, &mut |n| {
                if self.inlineable_calls.contains(n) {
                    self.requires_shadowed += 1;
                }
                self.declare_local(n.clone());
            });
        }
        if let Some(body) = &f.body {
            collect_fn_var_atoms(body, &mut |n| {
                if self.inlineable_calls.contains(n) {
                    self.requires_shadowed += 1;
                }
                self.declare_local(n.clone());
            });
        }
        f.visit_mut_children_with(self);
        self.pop_scope();
    }

    fn visit_mut_arrow_expr(&mut self, f: &mut ArrowExpr) {
        self.push_scope();
        for param in &f.params {
            collect_pat_atoms(param, &mut |n| {
                if self.inlineable_calls.contains(n) {
                    self.requires_shadowed += 1;
                }
                self.declare_local(n.clone());
            });
        }
        if let BlockStmtOrExpr::BlockStmt(body) = f.body.as_ref() {
            collect_fn_var_atoms(body, &mut |n| {
                if self.inlineable_calls.contains(n) {
                    self.requires_shadowed += 1;
                }
                self.declare_local(n.clone());
            });
        }
        f.visit_mut_children_with(self);
        self.pop_scope();
    }

    fn visit_mut_assign_expr(&mut self, n: &mut AssignExpr) {
        // If the direct assignment target is a candidate identifier (e.g. `foo = ...`),
        // mark it as skip so it is never inlined.  This must happen before we
        // recurse so that the identifier on the left is not accidentally replaced.
        if let AssignTarget::Simple(SimpleAssignTarget::Ident(id)) = &n.left {
            if self.candidates.contains_key(&id.id.sym) && !self.is_locally_shadowed(&id.id.sym) {
                self.skip.insert(id.id.sym.clone());
            }
        }
        // Visit BOTH sides.  Computed-property expressions on the left (e.g.
        // `this[_EventInternals.KEY] = ...`) contain candidate identifiers that
        // must be replaced.  The simple-ident case above is already guarded by
        // `skip`; additionally, `visit_mut_children_with` on a
        // `SimpleAssignTarget::Ident` calls `visit_mut_ident`, not
        // `visit_mut_expr`, so `maybe_replace` is never triggered for it.
        n.visit_mut_children_with(self);
    }

    fn visit_mut_update_expr(&mut self, n: &mut UpdateExpr) {
        if let Expr::Ident(id) = n.arg.as_ref() {
            if self.candidates.contains_key(&id.sym) && !self.is_locally_shadowed(&id.sym) {
                self.skip.insert(id.sym.clone());
            }
        }
    }

    fn visit_mut_prop(&mut self, prop: &mut Prop) {
        // `{ foo }` shorthand — the `foo` identifier lives under
        // `Prop::Shorthand`, not as an `Expr`, so `visit_mut_expr` never
        // sees it. When `foo` is an inline candidate, rewrite the
        // shorthand into an explicit `foo: <inlined>` key-value pair so
        // the inlining actually happens.
        if let Prop::Shorthand(id) = prop {
            if let Some(candidate) = self.candidates.get(&id.sym) {
                let replace_ok = !self.is_locally_shadowed(&id.sym)
                    && self.requires_shadowed == 0
                    && !self.skip.contains(&id.sym);
                if replace_ok {
                    let name = id.sym.clone();
                    let key = PropName::Ident(IdentName::new(id.sym.clone(), id.span));
                    let value = Box::new(self.build_substitute(&name, candidate));
                    self.replaced.insert(name);
                    *prop = Prop::KeyValue(KeyValueProp { key, value });
                    return;
                }
            }
        }
        prop.visit_mut_children_with(self);
    }

    // JSX runs BEFORE SWC's JSX → `jsxDEV(...)` transform, so opening/closing
    // element names and JSX member expressions still carry raw identifiers
    // that JSX grammar requires. We can't substitute a `require(...).prop`
    // call into a JSX name — only identifiers are valid there — so any
    // candidate referenced as the root of a JSX element name must keep its
    // declaration or the post-JSX-transform output ends up with a dangling
    // `RootTagContext` reference and throws a ReferenceError at runtime.
    //
    // Mark such candidates as `skip` so the declaration survives phase 3.
    // We still need to visit children so nested expressions (JSX attribute
    // values, child expressions, etc.) get their normal inlining.
    fn visit_mut_jsx_element_name(&mut self, name: &mut JSXElementName) {
        match name {
            JSXElementName::Ident(id) => self.mark_unreplaceable_ref(&id.sym),
            JSXElementName::JSXMemberExpr(m) => self.mark_jsx_member_root(&m.obj),
            JSXElementName::JSXNamespacedName(_) => {}
        }
        name.visit_mut_children_with(self);
    }

    fn visit_mut_jsx_member_expr(&mut self, n: &mut JSXMemberExpr) {
        self.mark_jsx_member_root(&n.obj);
        n.visit_mut_children_with(self);
    }

    // `export { X, Y as Z };` (re-export of local bindings, no `from` clause)
    // references the declared locals via `ExportNamedSpecifier.orig`, which is
    // a `ModuleExportName` rather than an `Expr`. `visit_mut_expr` never sees
    // them, so without marking here the candidate declarations get removed
    // and SWC's downstream CJS pass emits `get X() { return X; }` against an
    // undefined local → runtime ReferenceError.
    //
    // Re-exports WITH a `from` clause (`export { X } from "m"`) don't touch
    // local bindings — `orig` is a remote export name — so skip those.
    fn visit_mut_named_export(&mut self, n: &mut NamedExport) {
        if n.src.is_none() {
            for spec in &n.specifiers {
                if let ExportSpecifier::Named(named) = spec {
                    if let ModuleExportName::Ident(id) = &named.orig {
                        self.mark_unreplaceable_ref(&id.sym);
                    }
                }
            }
        }
        n.visit_mut_children_with(self);
    }
}

impl<'a> InlineReplacer<'a> {
    /// Mark a candidate as `skip` when its identifier appears in an AST
    /// position `visit_mut_expr` can't reach (JSX element names, export
    /// specifiers, …). The declaration must survive phase 3 so downstream
    /// passes — SWC's JSX transform, SWC's CJS export helper — can still
    /// resolve the name.
    fn mark_unreplaceable_ref(&mut self, name: &Atom) {
        if self.candidates.contains_key(name) && !self.is_locally_shadowed(name) {
            self.skip.insert(name.clone());
        }
    }

    fn mark_jsx_member_root(&mut self, obj: &JSXObject) {
        match obj {
            JSXObject::Ident(id) => self.mark_unreplaceable_ref(&id.sym),
            JSXObject::JSXMemberExpr(inner) => self.mark_jsx_member_root(&inner.obj),
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 3: remove declarations
// ---------------------------------------------------------------------------

fn remove_declarations(
    program: &mut Program,
    candidates: &FxHashMap<Atom, Candidate>,
    skip: &FxHashSet<Atom>,
) {
    // Build map: stmt_idx → set of decl_idx to remove
    let mut to_remove: FxHashMap<usize, FxHashSet<usize>> = FxHashMap::default();

    for (name, candidate) in candidates {
        if skip.contains(name) {
            continue;
        }
        // Remove regardless of whether it was replaced (even unused requires get removed)
        to_remove
            .entry(candidate.stmt_idx)
            .or_default()
            .insert(candidate.decl_idx);
    }

    if to_remove.is_empty() {
        return;
    }

    match program {
        Program::Module(m) => {
            let mut stmt_indices: Vec<usize> = to_remove.keys().cloned().collect();
            stmt_indices.sort_unstable();
            stmt_indices.reverse();

            for stmt_idx in stmt_indices {
                if stmt_idx >= m.body.len() {
                    continue;
                }
                if let ModuleItem::Stmt(Stmt::Decl(Decl::Var(vd))) = &mut m.body[stmt_idx] {
                    let decls_to_remove = &to_remove[&stmt_idx];
                    let new_decls: Vec<VarDeclarator> = vd
                        .decls
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| !decls_to_remove.contains(i))
                        .map(|(_, d)| d.clone())
                        .collect();
                    if new_decls.is_empty() {
                        m.body.remove(stmt_idx);
                    } else {
                        vd.decls = new_decls;
                    }
                }
            }
        }
        Program::Script(s) => {
            let mut stmt_indices: Vec<usize> = to_remove.keys().cloned().collect();
            stmt_indices.sort_unstable();
            stmt_indices.reverse();

            for stmt_idx in stmt_indices {
                if stmt_idx >= s.body.len() {
                    continue;
                }
                if let Stmt::Decl(Decl::Var(vd)) = &mut s.body[stmt_idx] {
                    let decls_to_remove = &to_remove[&stmt_idx];
                    let new_decls: Vec<VarDeclarator> = vd
                        .decls
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| !decls_to_remove.contains(i))
                        .map(|(_, d)| d.clone())
                        .collect();
                    if new_decls.is_empty() {
                        s.body.remove(stmt_idx);
                    } else {
                        vd.decls = new_decls;
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Memoization: hoist `var <name>;` to the top of the program.
// ---------------------------------------------------------------------------

fn hoist_memo_vars(program: &mut Program, names: &FxHashSet<Atom>) {
    if names.is_empty() {
        return;
    }
    let mut sorted: Vec<&Atom> = names.iter().collect();
    sorted.sort_by(|a, b| a.as_ref().cmp(b.as_ref()));

    let decls: Vec<VarDeclarator> = sorted
        .iter()
        .map(|name| VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent {
                id: Ident::new((*name).clone(), DUMMY_SP, Default::default()),
                type_ann: None,
            }),
            init: None,
            definite: false,
        })
        .collect();

    let var_decl = Box::new(VarDecl {
        span: DUMMY_SP,
        kind: VarDeclKind::Var,
        declare: false,
        decls,
        ctxt: Default::default(),
    });

    match program {
        Program::Module(m) => {
            m.body
                .insert(0, ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))));
        }
        Program::Script(s) => {
            s.body.insert(0, Stmt::Decl(Decl::Var(var_decl)));
        }
    }
}

// ---------------------------------------------------------------------------
// Nested-shadow rename pre-pass
//
// For every nested function / arrow body that contains `function <name>(){}`
// where `<name>` is one of the inlineable-call names (`require`,
// `customStuff`, …), rename the declaration AND every identifier reference
// to `<name>` inside the body to `_<name>`. This mirrors Babel
// `scope.rename(requireFnName)` semantics and keeps subsequently-inlined
// `require(...)` calls pointing at the module-level global.
// ---------------------------------------------------------------------------

fn rename_nested_shadows(program: &mut Program, inlineable_calls: &FxHashSet<Atom>) {
    let mut renamer = ShadowRenamer { inlineable_calls };
    program.visit_mut_with(&mut renamer);
}

struct ShadowRenamer<'a> {
    inlineable_calls: &'a FxHashSet<Atom>,
}

impl<'a> ShadowRenamer<'a> {
    fn collect_shadows(&self, stmts: &[Stmt]) -> FxHashMap<Atom, Atom> {
        let mut out: FxHashMap<Atom, Atom> = FxHashMap::default();
        for stmt in stmts {
            if let Stmt::Decl(Decl::Fn(fd)) = stmt {
                if self.inlineable_calls.contains(&fd.ident.sym) {
                    let renamed = Atom::from(format!("_{}", fd.ident.sym.as_ref()));
                    out.insert(fd.ident.sym.clone(), renamed);
                }
            }
        }
        out
    }
}

impl<'a> VisitMut for ShadowRenamer<'a> {
    fn visit_mut_function(&mut self, f: &mut Function) {
        if let Some(body) = &mut f.body {
            let renames = self.collect_shadows(&body.stmts);
            if !renames.is_empty() {
                let mut bulk = BulkIdentRenamer { renames: &renames };
                body.visit_mut_with(&mut bulk);
            }
        }
        f.visit_mut_children_with(self);
    }

    fn visit_mut_arrow_expr(&mut self, a: &mut ArrowExpr) {
        if let BlockStmtOrExpr::BlockStmt(body) = a.body.as_mut() {
            let renames = self.collect_shadows(&body.stmts);
            if !renames.is_empty() {
                let mut bulk = BulkIdentRenamer { renames: &renames };
                body.visit_mut_with(&mut bulk);
            }
        }
        a.visit_mut_children_with(self);
    }
}

/// Renames every `Ident` matching a key in `renames` to its mapped value.
/// Stops recursing when it enters a nested function/arrow whose own body
/// redeclares the same name (simple scope awareness — good enough for the
/// shadowing cases the metro tests exercise).
struct BulkIdentRenamer<'a> {
    renames: &'a FxHashMap<Atom, Atom>,
}

impl<'a> VisitMut for BulkIdentRenamer<'a> {
    fn visit_mut_ident(&mut self, n: &mut Ident) {
        if let Some(new_name) = self.renames.get(&n.sym) {
            n.sym = new_name.clone();
        }
    }

    fn visit_mut_prop(&mut self, p: &mut Prop) {
        // `{ require }` shorthand expands to `{ require: require }`. When we
        // rename `require` → `_require`, keep the property name `require`
        // and only rename the value identifier.
        if let Prop::Shorthand(id) = p {
            if let Some(new_name) = self.renames.get(&id.sym) {
                let key_name = id.sym.clone();
                let value = Ident::new(new_name.clone(), id.span, id.ctxt);
                *p = Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(IdentName::new(key_name, id.span)),
                    value: Box::new(Expr::Ident(value)),
                });
                return;
            }
        }
        p.visit_mut_children_with(self);
    }

    fn visit_mut_function(&mut self, f: &mut Function) {
        // Stop if this nested function redeclares one of the renamed names
        // (`function require(){}` inside a scope where `require` is already
        // being renamed). Otherwise continue so nested uses get renamed.
        let redeclares = f
            .body
            .as_ref()
            .map(|b| {
                b.stmts.iter().any(|s| {
                    if let Stmt::Decl(Decl::Fn(fd)) = s {
                        self.renames.contains_key(&fd.ident.sym)
                    } else {
                        false
                    }
                })
            })
            .unwrap_or(false);
        if redeclares {
            return;
        }
        f.visit_mut_children_with(self);
    }

    fn visit_mut_arrow_expr(&mut self, a: &mut ArrowExpr) {
        let redeclares = match a.body.as_ref() {
            BlockStmtOrExpr::BlockStmt(b) => b.stmts.iter().any(|s| {
                if let Stmt::Decl(Decl::Fn(fd)) = s {
                    self.renames.contains_key(&fd.ident.sym)
                } else {
                    false
                }
            }),
            BlockStmtOrExpr::Expr(_) => false,
        };
        if redeclares {
            return;
        }
        a.visit_mut_children_with(self);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn collect_pat_atoms(pat: &Pat, emit: &mut dyn FnMut(&Atom)) {
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

fn collect_fn_var_atoms(block: &BlockStmt, emit: &mut dyn FnMut(&Atom)) {
    for stmt in &block.stmts {
        collect_var_in_stmt(stmt, emit);
    }
}

fn collect_var_in_stmt(stmt: &Stmt, emit: &mut dyn FnMut(&Atom)) {
    match stmt {
        Stmt::Decl(Decl::Var(vd)) if vd.kind == VarDeclKind::Var => {
            for d in &vd.decls {
                collect_pat_atoms(&d.name, emit);
            }
        }
        Stmt::Decl(Decl::Fn(fd)) => {
            emit(&fd.ident.sym);
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

// ---------------------------------------------------------------------------
// Structural Expr equality + member-assignment scan (for phase 1 filter).
// ---------------------------------------------------------------------------

fn collect_member_assignment_targets(program: &Program) -> Vec<Expr> {
    use swc_core::ecma::visit::{Visit, VisitWith};
    struct Collector {
        targets: Vec<Expr>,
    }
    impl Visit for Collector {
        fn visit_assign_expr(&mut self, n: &AssignExpr) {
            if let AssignTarget::Simple(SimpleAssignTarget::Member(m)) = &n.left {
                self.targets.push(Expr::Member(m.clone()));
            }
            n.visit_children_with(self);
        }
    }
    let mut c = Collector { targets: vec![] };
    program.visit_with(&mut c);
    c.targets
}

fn expr_equal(a: &Expr, b: &Expr) -> bool {
    let a = unwrap_paren(a);
    let b = unwrap_paren(b);
    match (a, b) {
        (Expr::Ident(x), Expr::Ident(y)) => x.sym == y.sym,
        (Expr::Lit(x), Expr::Lit(y)) => match (x, y) {
            (Lit::Str(s1), Lit::Str(s2)) => s1.value == s2.value,
            (Lit::Num(n1), Lit::Num(n2)) => n1.value == n2.value,
            (Lit::Bool(b1), Lit::Bool(b2)) => b1.value == b2.value,
            (Lit::Null(_), Lit::Null(_)) => true,
            _ => false,
        },
        (Expr::Call(c1), Expr::Call(c2)) => {
            callee_equal(&c1.callee, &c2.callee)
                && c1.args.len() == c2.args.len()
                && c1
                    .args
                    .iter()
                    .zip(&c2.args)
                    .all(|(a1, a2)| expr_equal(&a1.expr, &a2.expr))
        }
        (Expr::Member(m1), Expr::Member(m2)) => {
            expr_equal(&m1.obj, &m2.obj) && member_prop_equal(&m1.prop, &m2.prop)
        }
        (Expr::This(_), Expr::This(_)) => true,
        _ => false,
    }
}

fn callee_equal(a: &Callee, b: &Callee) -> bool {
    match (a, b) {
        (Callee::Expr(x), Callee::Expr(y)) => expr_equal(x, y),
        _ => false,
    }
}

fn member_prop_equal(a: &MemberProp, b: &MemberProp) -> bool {
    match (a, b) {
        (MemberProp::Ident(x), MemberProp::Ident(y)) => x.sym == y.sym,
        (MemberProp::Computed(x), MemberProp::Computed(y)) => expr_equal(&x.expr, &y.expr),
        _ => false,
    }
}
