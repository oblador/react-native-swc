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
