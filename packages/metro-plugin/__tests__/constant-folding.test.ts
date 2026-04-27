/**
 * Ported from metro/packages/metro-transform-plugins/src/__tests__/constant-folding-plugin-test.js
 */

import { compareConstantFolding } from './test-helpers';

describe('constant expressions', () => {
  test('can optimize conditional expressions with constant conditions', () => {
    const code = `
      a(
        'production' == "production",
        'production' !== 'development',
        false && 1 || 0 || 2,
        true || 3,
        'android' === 'ios' ? null : {},
        'android' === 'android' ? {a: 1} : {a: 0},
        'foo' === 'bar' ? b : c,
        f() ? g() : h(),
      );
    `;

    const expected = `
      a(true, true, 2, true, {}, {a: 1}, c, f() ? g() : h());
    `;

    compareConstantFolding(code, expected);
  });

  test('can optimize ternary expressions with constant conditions', () => {
    const code = `
       var a = true ? 1 : 2;
       var b = 'android' == 'android'
         ? ('production' != 'production' ? 'a' : 'A')
         : 'i';
    `;

    const expected = `
      var a = 1;
      var b = 'A';
    `;

    compareConstantFolding(code, expected);
  });

  test('can optimize logical operator expressions with constant conditions', () => {
    const code = `
      var a = true || 1;
      var b = 'android' == 'android' &&
        'production' != 'production' || null || "A";
    `;

    const expected = `
      var a = true;
      var b = "A";
    `;

    compareConstantFolding(code, expected);
  });

  test('can optimize logical operators with partly constant operands', () => {
    const code = `
      var a = "truthy" || z();
      var b = "truthy" && z();
      var c = null && z();
      var d = null || z();
      var e = !1 && z();
      var f = z() && undefined || undefined;
    `;

    const expected = `
      var a = "truthy";
      var b = z();
      var c = null;
      var d = z();
      var e = false;
      var f = z() && undefined || undefined;
    `;

    compareConstantFolding(code, expected);
  });

  test('folds null coalescing operator', () => {
    const code = `
      var a = undefined ?? u();
      var b = null ?? v();
      var c = false ?? w();
      var d = 0 ?? x();
      var e = NaN ?? x();
      var f = "truthy" ?? z();
    `;

    const expected = `
      var a = u();
      var b = v();
      var c = false;
      var d = 0;
      var e = NaN;
      var f = "truthy";
    `;

    compareConstantFolding(code, expected);
  });

  test('can remode an if statement with a falsy constant test', () => {
    const code = `
      if ('production' === 'development' || false) {
        var a = 1;
      }
    `;

    compareConstantFolding(code, '');
  });

  test('does not fold non-literal void expressions', () => {
    const code = `
      void obj.prop;
    `;

    compareConstantFolding(code, code);
  });

  test('folds literal void expressions', () => {
    const code = `
      if (void 0) {
        foo();
      }
    `;

    compareConstantFolding(code, '');
  });

  test('can optimize if-else-branches with constant conditions', () => {
    // The if-test is folded; the live branch is kept as-is. We do NOT
    // propagate `var a = 3` into the `var b = a + 4` initializer because
    // process-global variable tracking without scope analysis miscompiled
    // real code (see `eval_expr` doc comment in constant_folding.rs).
    // The minifier reduces `a + 4` → `7` in production anyway.
    const code = `
      if ('production' == 'development') {
        var a = 1;
        var b = a + 2;
      } else if ('development' == 'development') {
        var a = 3;
        var b = a + 4;
      } else {
        var a = 'b';
      }
    `;

    const expected = `
      {
        var a = 3;
        var b = a + 4;
      }
    `;

    compareConstantFolding(code, expected);
  });

  test('can optimize nested if-else constructs', () => {
    const code = `
      if ('ios' === "android") {
        if (true) {
          require('a');
        } else {
          require('b');
        }
      } else if ('android' === 'android') {
        if (true) {
          require('c');
        } else {
          require('d');
        }
      }
    `;

    const expected = `
      {
        {
          require('c');
        }
      }
    `;

    compareConstantFolding(code, expected);
  });

  test('does not leak inner-scope variable bindings into outer scopes', () => {
    // Regression: a previous implementation of constant folding tracked
    // variable bindings in a process-global hashmap with no scope analysis.
    // An inner-function `var TotalLanes = <huge>` would leak into the outer
    // scope's binding table and miscompile a subsequent function's
    // `i < TotalLanes` loop test, replacing it with a literal `true` and
    // producing infinite loops / multi-hundred-million-element array
    // allocations in React's production build (`createLaneMap` was the
    // canonical victim). The pass now refuses to evaluate identifier
    // references at all, so this code must round-trip unchanged.
    const code = `
      function inner() {
        var TotalLanes = 268414844;
        use(TotalLanes);
      }
      function createLaneMap() {
        for(var i = 0; i < TotalLanes; i++){
          laneMap.push(initial);
        }
      }
      var TotalLanes = 31;
      inner();
      createLaneMap();
    `;
    compareConstantFolding(code, code);
  });

  test('does not propagate variable bindings into expressions', () => {
    // Pinned: variable propagation across statements is intentionally NOT
    // performed. A previous implementation tracked `var x = 3` in a process-
    // global hashmap with no scope or use-def analysis, which miscompiled
    // React's production build (an inner-scope `var TotalLanes = <huge>`
    // leaked into another function's loop test, producing a huge array
    // allocation). Folding stays at the literal-only level here; the
    // minifier handles the rest in production.
    const code = `
      var x = 3;

      if (x - 3) {
        require('a');
      }
    `;
    compareConstantFolding(code, code);
  });

  test('does not fold logical expressions involving identifier bindings', () => {
    const code = `
      var x = 3;
      var y = (x - 3) || 4;
      var z = (y - 4) && 4;
    `;
    compareConstantFolding(code, code);
  });

  // Original Metro-style test from the upstream port — moved to a literal
  // form that doesn't depend on cross-statement variable tracking.
  test('folds logical expressions with literal operands', () => {
    const code = `
      var y = 0 || 4;
      var z = 0 && 4;
    `;

    const expected = `
      var y = 4;
      var z = 0;
    `;

    compareConstantFolding(code, expected);
  });

  test('wipes unused functions', () => {
    const code = `
      var xUnused = function () {
        console.log(100);
      };

      var yUnused = () => {
        console.log(200);
      };

      function zUnused() {
        console.log(300);
      }

      var xUsed = () => {
        console.log(400);
      };

      var yUsed = function () {
        console.log(500);
      };

      function zUsed() {
        console.log(600);
      }

      (() => {
        console.log(700);
      })();

      xUsed();
      yUsed();
      zUsed();
    `;

    const expected = `
      var xUsed = () => {
        console.log(400);
      };

      var yUsed = function() {
        console.log(500);
      };

      function zUsed() {
        console.log(600);
      }

      (() => {
        console.log(700);
      })();

      xUsed();
      yUsed();
      zUsed();
    `;

    compareConstantFolding(code, expected);
  });

  test('recursively strips off functions', () => {
    const code = `
      function x() {}

      if (false) {
        x();
      }
    `;

    compareConstantFolding(code, '');
  });

  test('preserves functions referenced from sibling ESM export declarations', () => {
    // Regression: SWC plugins run BEFORE the ESM→CJS transform, so the
    // dead-code pass sees `function defineLazyObjectProperty(...) {}` paired
    // with `export default defineLazyObjectProperty;` as a `Stmt::Decl(Fn)`
    // sibling of a `ModuleDecl::ExportDefaultExpr`. The reference walker
    // previously only iterated `ModuleItem::Stmt` items, missing the
    // `ExportDefaultExpr`'s reference and dropping the function declaration —
    // crashing the post-CJS bundle with `Property 'defineLazyObjectProperty'
    // doesn't exist`. This is the exact shape RN's
    // `Libraries/Utilities/defineLazyObjectProperty.js` emits.
    const code = `
      function helper() {}
      export default helper;
    `;
    compareConstantFolding(code, code);
  });

  test('preserves functions referenced via export specifiers and named exports', () => {
    // `export { foo }` and `export { foo as bar }` register `foo` as
    // referenced through `visit_export_named_specifier`. Without that, an
    // otherwise-unused `function foo() {}` would be deleted while the
    // export specifier kept naming it.
    const code = `
      function reExported() {}
      function aliased() {}
      export { reExported, aliased as renamed };
    `;
    compareConstantFolding(code, code);
  });

  test('preserves functions referenced from non-trivial expression contexts', () => {
    // Regression: the earlier hand-rolled reference walker only handled a
    // curated subset of expression shapes (bin/call/tpl/...) and silently
    // missed object literals, arrays, ternaries, `new X()`, optional chains,
    // spreads, etc. The `@react-native/js-polyfills/console.js` polyfill
    // calls `getNativeLogFunction` only inside an object literal, so the
    // function declaration was being dropped while its calls remained,
    // crashing minified bundles with `Property 'getNativeLogFunction'
    // doesn't exist`.
    const code = `
      function objLit() {}
      function arrLit() {}
      function ternaryT() {}
      function ternaryF() {}
      function newCtor() {}
      function optChain() {}
      function spread() {}
      function tagged() {}
      function shorthand() {}
      function defaultArg() {}
      function classProp() {}
      var sink;
      sink = { a: objLit() };
      sink = [arrLit()];
      sink = cond ? ternaryT() : ternaryF();
      sink = new newCtor();
      sink = obj?.[optChain()];
      sink = [...spread()];
      sink = tagged\`x\`;
      var ref = shorthand;
      sink = { ref };
      function consumer(x = defaultArg()) {}
      consumer();
      class C { value = classProp(); }
      new C();
    `;

    // Every fn declaration should survive — every one is referenced from a
    // shape the rewritten Visit-based collector now walks correctly.
    const out = code; // expected unchanged
    compareConstantFolding(code, out);
  });

  test('verifies that mixes of variables and functions properly minifies', () => {
    // `y` is unused (its arrow init is never referenced) → declarator is
    // dropped by `remove_unused_fn_declarators`. The `if (x)` is preserved
    // because we don't propagate `var x = 2` (see other tests above for the
    // rationale); the minifier folds it in production.
    const code = `
      var x = 2;
      var y = () => x - 2;

      if (x) {
        z();
      }
    `;

    const expected = `
      var x = 2;
      if (x) {
        z();
      }
    `;

    compareConstantFolding(code, expected);
  });

  test('does not mess up with negative numbers', () => {
    const code = `
      var plusZero = +0;
      var zero = 0;
      var minusZero = -0;
      var plusOne = +1;
      var one = 1;
      var minusOne = -1;
    `;

    const expected = `
      var plusZero = 0;
      var zero = 0;
      var minusZero = -0;
      var plusOne = 1;
      var one = 1;
      var minusOne =- 1;
    `;

    compareConstantFolding(code, expected);
  });

  test('does not mess up default exports', () => {
    const nonChanged = [
      'export default function () {}',
      'export default () => {}',
      'export default class {}',
      'export default 1',
    ];

    nonChanged.forEach((snippet) => compareConstantFolding(snippet, snippet));
  });

  test('will not throw on evaluate exception', () => {
    const nonChanged = `
      Object({ 'toString': 0 } + '');
    `;

    compareConstantFolding(nonChanged, nonChanged);
  });

  test('does not confuse function identifiers with variables in inner scope', () => {
    const code = `
      export function foo() {
        let foo;
      }
    `;

    const expected = `
      export function foo() {
        let foo;
      }
    `;

    compareConstantFolding(code, expected);
  });

  test('does not transform optional chained call into `undefined`', () => {
    const code = `foo?.();`;

    const expected = `foo?.();`;

    compareConstantFolding(code, expected);
  });

  test('does not transform `void` prefixed optional chained call into `undefined`', () => {
    const code = `void foo?.();`;

    const expected = `void foo?.();`;

    compareConstantFolding(code, expected);
  });
});
