/**
 * Ported from metro/packages/metro-transform-plugins/src/__tests__/inline-requires-plugin-test.js
 *
 * Upstream exercises the plugin via `babel-plugin-tester`'s snapshot mechanism;
 * here we use `compareInlineRequires(input, expected, opts)` which re-prints
 * both snippets through SWC so formatting is normalized.
 *
 * Some of the `TEST_CASES` from upstream are snapshot-only ("snapshot: true")
 * while others assert that input == output ("snapshot: false"). For the
 * snapshot cases we build the expected output by hand, mirroring upstream's
 * snapshots.
 */

import { runPass, type InlineRequiresOptions } from './run-pass';
import { compareInlineRequires } from './test-helpers';

// Options used across the per-case tests so the behavior matches upstream's
// pluginTester invocation.
const SHARED_OPTS: InlineRequiresOptions = {
  nonInlinedRequires: ['CommonFoo'],
  extraInlineableCalls: ['customStuff'],
};

describe('memoizeCalls=false:', () => {
  const opts: InlineRequiresOptions = { ...SHARED_OPTS, memoizeCalls: false };

  test('inlines single usage', () => {
    compareInlineRequires(
      ['var foo = require("foo");', 'foo.bar()'].join('\n'),
      'require("foo").bar();',
      opts,
    );
  });

  test('inlines multiple usages', () => {
    compareInlineRequires(
      ['var foo = require("foo");', 'foo.bar()', 'foo.baz()'].join('\n'),
      ['require("foo").bar();', 'require("foo").baz();'].join('\n'),
      opts,
    );
  });

  test('inlines any number of variable declarations', () => {
    compareInlineRequires(
      ['var foo = require("foo"), bar = require("bar"), baz = 4;', 'foo.method()'].join('\n'),
      ['var baz = 4;', 'require("foo").method();'].join('\n'),
      opts,
    );
  });

  test('ignores requires that are not assigned', () => {
    const code = 'require("foo");';
    compareInlineRequires(code, code, opts);
  });

  test('delete unused requires', () => {
    compareInlineRequires('var foo = require("foo");', '', opts);
  });

  test('ignores requires that are re-assigned', () => {
    const code = ['var foo = require("foo");', 'foo = "bar";'].join('\n');
    compareInlineRequires(code, code, opts);
  });

  test('ensures that the inlined require still points to the global require function', () => {
    const code = `
        const foo = require('foo');

        function test() {
          function require(condition) {
            if (!condition) {
              throw new Error('Condition is falsy');
            }
          }

          require(foo.isOnline());
        }
      `;
    const expected = `
        function test() {
          function _require(condition) {
            if (!condition) {
              throw new Error('Condition is falsy');
            }
          }

          _require(require('foo').isOnline());
        }
      `;
    compareInlineRequires(code, expected, opts);
  });

  test('ensures that the inlined require still points to the global require function with inlineableCalls options', () => {
    const code = `
        const foo = customStuff('foo');

        function test() {
          function customStuff(condition) {
            if (!condition) {
              throw new Error('Condition is falsy');
            }
          }

          customStuff(foo.isOnline());
        }
      `;
    const expected = `
        function test() {
          function _customStuff(condition) {
            if (!condition) {
              throw new Error('Condition is falsy');
            }
          }

          _customStuff(customStuff('foo').isOnline());
        }
      `;
    compareInlineRequires(code, expected, opts);
  });

  test('ensures that the inlined require still points to the global require function even if local require is not called', () => {
    const code = `
        const foo = require('foo');

        function test() {
          function _require(condition) {
            if (!condition) {
              throw new Error('Condition is falsy');
            }
          }

          foo.isOnline();
        }
      `;
    const expected = `
        function test() {
          function _require(condition) {
            if (!condition) {
              throw new Error('Condition is falsy');
            }
          }

          require('foo').isOnline();
        }
      `;
    compareInlineRequires(code, expected, opts);
  });

  test('does not transform require calls if require is redeclared in the same declaration scope', () => {
    const code = `
          function require(condition) {
            if (!condition) {
              throw new Error('Condition is falsy');
            }
          }
          const foo = require('foo');
          console.log(foo.test);
        `;
    compareInlineRequires(code, code, opts);
  });

  test('does not transform require calls if require is redeclared in the global scope', () => {
    const code = `
          function require(condition) {
            if (!condition) {
              throw new Error('Condition is falsy');
            }
          }
          function test() {
            const foo = require('foo');
            console.log(foo.test);
          }
        `;
    compareInlineRequires(code, code, opts);
  });

  test('does not inline a candidate shadowed by a class constructor parameter', () => {
    // `Constructor` is its own AST node (not a `Function`)
    const code = [
      'var foo = require("foo");',
      'class C {',
      '  constructor(foo) {',
      '    this.bar = foo.bar;',
      '  }',
      '}',
    ].join('\n');
    compareInlineRequires(code, code, opts);
  });

  test('does not inline a candidate shadowed by a class method parameter', () => {
    // Companion to the constructor regression — class methods route through
    // `visit_mut_function` (their inner `function` is a real `Function`
    // node), but it's worth pinning the behaviour explicitly so a future
    // visitor refactor doesn't quietly regress it.
    const code = [
      'var foo = require("foo");',
      'class C {',
      '  m(foo) {',
      '    return foo.bar;',
      '  }',
      '}',
    ].join('\n');
    compareInlineRequires(code, code, opts);
  });

  test('does not transform require calls that are already inline', () => {
    const code = `
        function test() {
          function _require(condition) {
            if (!condition) {
              throw new Error('The condition is false');
            }
          }
          _require('test');
        }
      `;
    compareInlineRequires(code, code, opts);
  });

  test('inlines requires that are referenced before the require statement', () => {
    compareInlineRequires(
      ['function foo() {', '  bar();', '}', 'var bar = require("baz");', 'foo();', 'bar();'].join(
        '\n',
      ),
      ['function foo() {', '  require("baz")();', '}', 'foo();', 'require("baz")();'].join('\n'),
      opts,
    );
  });

  test('inlines require properties', () => {
    compareInlineRequires(
      [
        'var tmp = require("./a");',
        'var a = tmp.a',
        'var D = {',
        '  b: function(c) { c ? a(c.toString()) : a("No c!"); },',
        '};',
      ].join('\n'),
      [
        'var D = {',
        '  b: function(c) { c ? require("./a").a(c.toString()) : require("./a").a("No c!"); },',
        '};',
      ].join('\n'),
      opts,
    );
  });

  test('ignores require properties (as identifiers) that are re-assigned', () => {
    compareInlineRequires(
      ['var X = require("X");', 'var origA = X.a', 'X.a = function() {', '  origA();', '};'].join(
        '\n',
      ),
      ['var origA = require("X").a;', 'require("X").a = function() {', '  origA();', '};'].join(
        '\n',
      ),
      opts,
    );
  });

  test('ignores require properties (as strings) that are re-assigned', () => {
    compareInlineRequires(
      [
        'var X = require("X");',
        'var origA = X["a"]',
        'X["a"] = function() {',
        '  origA();',
        '};',
      ].join('\n'),
      [
        'var origA = require("X")["a"];',
        'require("X")["a"] = function() {',
        '  origA();',
        '};',
      ].join('\n'),
      opts,
    );
  });

  test('inlines candidate referenced inside an update expression on a member', () => {
    // Regression: @shopify/react-native-skia's Canvas.tsx does
    // `SkiaViewNativeId.current++` against an imported binding. The named
    // import was promoted to a `var SkiaViewNativeId = require(...).SkiaViewNativeId`
    // candidate, but `visit_mut_update_expr` did not recurse into the
    // MemberExpr arg — so the use site was never inlined while the
    // declaration was still removed by phase 3, producing a runtime
    // ReferenceError ("Property 'SkiaViewNativeId' doesn't exist").
    compareInlineRequires(
      [
        'var SkiaViewNativeId = require("./id").SkiaViewNativeId;',
        'SkiaViewNativeId.current++;',
      ].join('\n'),
      'require("./id").SkiaViewNativeId.current++;',
      opts,
    );
  });

  test('keeps declaration when an update expression targets the candidate directly', () => {
    // `X++` on a candidate must keep `var X = require(...)` around — the
    // inlined form `(require("m"))++` would be an invalid update target.
    compareInlineRequires(
      ['var counter = require("./counter");', 'counter++;'].join('\n'),
      ['var counter = require("./counter");', 'counter++;'].join('\n'),
      opts,
    );
  });

  test('rewrites JSX element-name candidates through live getter helpers', () => {
    // JSX element names cannot be arbitrary expressions, so `<FooBar />`
    // cannot become `<require("m").FooBar />`. Use a generated JSX-legal
    // member expression whose getter performs the fresh require-property read
    // at the eventual jsx(...) call site.
    compareInlineRequires(
      [
        'var FooBar = require("m").FooBar;',
        'function Component() {',
        '  return <FooBar foo="bar" />;',
        '}',
      ].join('\n'),
      [
        'var _jsxImportFooBar = {',
        '  get FooBar() {',
        '    return require("m").FooBar;',
        '  }',
        '};',
        'function Component() {',
        '  return <_jsxImportFooBar.FooBar foo="bar" />;',
        '}',
      ].join('\n'),
      { ...opts, jsx: true },
    );
  });

  test('keeps non-JSX references inlineable when the same candidate is used as a JSX tag', () => {
    compareInlineRequires(
      [
        'var Foo = require("m").Foo;',
        'function Component() {',
        '  return <Foo />;',
        '}',
        'function getFoo() {',
        '  return Foo;',
        '}',
      ].join('\n'),
      [
        'var _jsxImportFoo = {',
        '  get Foo() {',
        '    return require("m").Foo;',
        '  }',
        '};',
        'function Component() {',
        '  return <_jsxImportFoo.Foo />;',
        '}',
        'function getFoo() {',
        '  return require("m").Foo;',
        '}',
      ].join('\n'),
      { ...opts, jsx: true },
    );
  });

  test('rewrites JSX member-expression roots through live getter helpers', () => {
    // `<HelperText.Container/>` — the root `HelperText` is a candidate; the
    // rewrite has to handle JSXMemberExpression element names too.
    compareInlineRequires(
      [
        'var HelperText = require("m").HelperText;',
        'function Component() {',
        '  return <HelperText.Container foo="bar" />;',
        '}',
      ].join('\n'),
      [
        'var _jsxImportHelperText = {',
        '  get HelperText() {',
        '    return require("m").HelperText;',
        '  }',
        '};',
        'function Component() {',
        '  return <_jsxImportHelperText.HelperText.Container foo="bar" />;',
        '}',
      ].join('\n'),
      { ...opts, jsx: true },
    );
  });

  test('keeps expression-body arrows expression-bodied when rewriting JSX tags', () => {
    compareInlineRequires(
      ['var X = require("m").X;', 'const C = () => <X />;'].join('\n'),
      [
        'var _jsxImportX = {',
        '  get X() {',
        '    return require("m").X;',
        '  }',
        '};',
        'const C = () => <_jsxImportX.X />;',
      ].join('\n'),
      { ...opts, jsx: true },
    );
  });

  test('preserves directive prologues when inserting JSX helpers', () => {
    compareInlineRequires(
      ['"use strict";', 'var X = require("m").X;', 'const C = <X />;'].join('\n'),
      [
        '"use strict";',
        'var _jsxImportX = {',
        '  get X() {',
        '    return require("m").X;',
        '  }',
        '};',
        'const C = <_jsxImportX.X />;',
      ].join('\n'),
      { ...opts, jsx: true },
    );
  });

  test('does not rewrite JSX tags that resolve to local lexical bindings', () => {
    compareInlineRequires(
      [
        'var Foo = require("m").Foo;',
        'function Component() {',
        '  const Foo = LocalFoo;',
        '  return <Foo />;',
        '}',
      ].join('\n'),
      ['function Component() {', '  const Foo = LocalFoo;', '  return <Foo />;', '}'].join('\n'),
      { ...opts, jsx: true },
    );
  });

  test('does not let for-head lexical bindings shadow later JSX tags', () => {
    compareInlineRequires(
      [
        'var Foo = require("m").Foo;',
        'function Component(items) {',
        '  for (const Foo of items) {',
        '    Foo();',
        '  }',
        '  return <Foo />;',
        '}',
      ].join('\n'),
      [
        'var _jsxImportFoo = {',
        '  get Foo() {',
        '    return require("m").Foo;',
        '  }',
        '};',
        'function Component(items) {',
        '  for (const Foo of items) {',
        '    Foo();',
        '  }',
        '  return <_jsxImportFoo.Foo />;',
        '}',
      ].join('\n'),
      { ...opts, jsx: true },
    );
  });

  test('inlines functions provided via `inlineableCalls`', () => {
    compareInlineRequires(
      [
        'const inlinedCustom = customStuff("foo");',
        'const inlinedRequire = require("bar");',
        '',
        'inlinedCustom();',
        'inlinedRequire();',
      ].join('\n'),
      ['customStuff("foo")();', 'require("bar")();'].join('\n'),
      opts,
    );
  });

  test('ignores requires in `ignoredRequires`', () => {
    const code = ['const CommonFoo = require("CommonFoo");', 'CommonFoo();'].join('\n');
    compareInlineRequires(code, code, opts);
  });

  test('ignores destructured properties of requires in `ignoredRequires`', () => {
    const code = [
      'const tmp = require("CommonFoo");',
      'const a = require("CommonFoo").a;',
      'a();',
    ].join('\n');
    compareInlineRequires(code, code, opts);
  });

  test('inlines require.resolve calls', () => {
    compareInlineRequires(
      ['const a = require(require.resolve("Foo")).bar;', '', 'a();'].join('\n'),
      'require(require.resolve("Foo")).bar();',
      opts,
    );
  });

  test('inlines with multiple arguments', () => {
    compareInlineRequires(
      ['const a = require("Foo", "Bar", 47);', '', 'a();'].join('\n'),
      'require("Foo", "Bar", 47)();',
      opts,
    );
  });
});

describe('memoizeCalls=true:', () => {
  const opts: InlineRequiresOptions = { ...SHARED_OPTS, memoizeCalls: true };

  test('hoists a bare var and wraps single reference', () => {
    compareInlineRequires(
      ['var foo = require("foo");', 'foo.bar()'].join('\n'),
      ['var foo;', '(foo || (foo = require("foo"))).bar();'].join('\n'),
      opts,
    );
  });

  test('member-init: full RHS is memoized', () => {
    compareInlineRequires(
      ['var a = require("./a").b;', 'a();'].join('\n'),
      ['var a;', '(a || (a = require("./a").b))();'].join('\n'),
      opts,
    );
  });

  test('JSX helper getters use the memoized substitute when memoizeCalls=true', () => {
    compareInlineRequires(
      ['var X = require("m").X;', 'function C() {', '  return <X />;', '}'].join('\n'),
      [
        'var X;',
        'var _jsxImportX = {',
        '  get X() {',
        '    return X || (X = require("m").X);',
        '  }',
        '};',
        'function C() {',
        '  return <_jsxImportX.X />;',
        '}',
      ].join('\n'),
      { ...opts, jsx: true },
    );
  });

  test('respects nonMemoizedModules', () => {
    const code = [
      'const foo = require("foo");',
      'const noMemo = require("noMemo");',
      'module.exports = function() {',
      '  foo();',
      '  noMemo();',
      '};',
    ].join('\n');

    const expected = [
      'var foo;',
      'module.exports = function(){',
      '(foo||(foo=require("foo")))();',
      'require("noMemo")();',
      '};',
    ].join('');

    const out = runPass(code, {
      pass: 'inlineRequires',
      memoizeCalls: true,
      nonMemoizedModules: ['noMemo'],
    });

    expect(out.replace(/\s+/g, '')).toEqual(expected.replace(/\s+/g, ''));
  });
});
