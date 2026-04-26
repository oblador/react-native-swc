/**
 * SWC Worklets Plugin Test Suite
 *
 * Ported from react-native-reanimated/packages/react-native-worklets/__tests__/plugin.test.ts
 * to exercise the SWC-based transform instead of the Babel plugin. The test
 * names, groupings and inputs mirror the upstream suite. Assertions are
 * adapted to behavioural checks (worklet count, location, inline-style
 * warning, substrings within the serialized worklet string) rather than raw
 * snapshot comparisons, because SWC and Babel produce syntactically-different
 * but semantically-equivalent code.
 *
 * NOTE: Build the WASM plugin before running: `pnpm build:wasm` (from
 * `packages/worklets-plugin`). Without it, every test is skipped.
 */

// `@types/jest` provides the global `namespace jest { interface Matchers<R> }`
// that rstest's `JestAssertion<T>` still extends. Pulling it in explicitly
// lets the augmentation below merge with the real interface, covering the
// `.not` / `.resolves` call paths that bypass `Assertion<T>`.
/// <reference types="jest" />

// Make this file a module so that `declare global { ... }` works.
export {};

import { transform as runTransform } from './run-plugin';

const MOCK_LOCATION = '/dev/null';

interface PluginOptions {
  bundleMode?: boolean;
  disableInlineStylesWarning?: boolean;
  disableSourceMaps?: boolean;
  disableWorkletClasses?: boolean;
  globals?: string[];
  relativeSourceLocation?: boolean;
  strictGlobal?: boolean;
  pluginVersion?: string;
}

function runPlugin(
  input: string,
  pluginOpts: PluginOptions = {},
  filename: string = MOCK_LOCATION,
): { code: string } {
  // Babel tests use an html<script>...</script> tag that strips the wrapper;
  // accept (and strip) the same wrapper so test inputs can be copied verbatim.
  const strippedInput = input.replace(/<\/?script[^>]*>/g, '');
  const code = runTransform(strippedInput, filename, pluginOpts);
  return { code };
}

// ---------------------------------------------------------------------------
// Custom matchers (port of reanimated's plugin/src/jestMatchers.ts)
// ---------------------------------------------------------------------------

const INIT_DATA_REGEX = /(^|\n)\s*(const|var) _worklet_[0-9]+_init_data/g;
const INLINE_STYLE_WARNING_REGEX =
  /console\.warn\(\s*require\(\s*["']react-native-reanimated["']\s*\)\s*\.\s*getUseOfValueInStyleWarning\(\)\s*\)/g;

function countInitData(code: string): number {
  return code.match(INIT_DATA_REGEX)?.length ?? 0;
}

function getWorkletStrings(code: string): string[] {
  const pattern = /code:\s*"((?:[^"\\]|\\.)*)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(code)) !== null) {
    out.push(m[1].replace(/\\(.)/g, '$1'));
  }
  return out;
}

expect.extend({
  toHaveWorkletData(received: string, expectedMatchCount = 1) {
    const actual = countInitData(received);
    if (actual === expectedMatchCount) {
      return {
        pass: true,
        message: () => 'expected not to have worklet data ' + expectedMatchCount + ' times',
      };
    }
    return {
      pass: false,
      message: () =>
        'expected worklet data ' +
        expectedMatchCount +
        ' times, got ' +
        actual +
        '.\n\nCode:\n' +
        received,
    };
  },

  toHaveInlineStyleWarning(received: string, expectedMatchCount = 1) {
    const actual = received.match(INLINE_STYLE_WARNING_REGEX)?.length ?? 0;
    if (actual === expectedMatchCount) {
      return {
        pass: true,
        message: () => 'expected not to have inline style warning ' + expectedMatchCount + ' times',
      };
    }
    return {
      pass: false,
      message: () =>
        'expected inline style warning ' +
        expectedMatchCount +
        ' times, got ' +
        actual +
        '.\n\nCode:\n' +
        received,
    };
  },

  toHaveLocation(received: string, location: string) {
    const escaped = location.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp('location:\\s*["\']' + escaped + '["\']');
    return re.test(received)
      ? {
          pass: true,
          message: () => 'expected not to have location ' + location,
        }
      : {
          pass: false,
          message: () => 'expected location ' + location + '.\n\nCode:\n' + received,
        };
  },

  toContainInWorkletString(received: string, expected: string) {
    const strings = getWorkletStrings(received);
    if (strings.some((s) => s.includes(expected))) {
      return {
        pass: true,
        message: () => 'expected worklet string NOT to contain "' + expected + '"',
      };
    }
    return {
      pass: false,
      message: () =>
        'expected worklet string to contain "' +
        expected +
        '".\n\nWorklet strings:\n' +
        strings.join('\n---\n'),
    };
  },

  toMatchInWorkletString(received: string, pattern: RegExp | string) {
    const strings = getWorkletStrings(received);
    const test =
      typeof pattern === 'string'
        ? (s: string) => s.includes(pattern)
        : (s: string) => pattern.test(s);
    if (strings.some(test)) {
      return {
        pass: true,
        message: () => 'expected worklet string NOT to match ' + pattern,
      };
    }
    return {
      pass: false,
      message: () =>
        'expected worklet string to match ' +
        pattern +
        '.\n\nWorklet strings:\n' +
        strings.join('\n---\n'),
    };
  },
});

// rstest has two type layers for assertions. `expect(x).foo()` is typed
// through the exported `Assertion<T>` interface; `.not` / `.resolves` /
// `.rejects` go through the inherited `JestAssertion<T>` chain that
// extends `jest.Matchers<void, T>`. Augment both so custom matchers are
// visible on every call path.
declare module '@rstest/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<T = any> {
    toHaveWorkletData(count?: number): void;
    toHaveInlineStyleWarning(count?: number): void;
    toHaveLocation(location: string): void;
    toContainInWorkletString(str: string): void;
    toMatchInWorkletString(pattern: RegExp | string): void;
  }
}
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toHaveWorkletData(count?: number): R;
      toHaveInlineStyleWarning(count?: number): R;
      toHaveLocation(location: string): R;
      toContainInWorkletString(str: string): R;
      toMatchInWorkletString(pattern: RegExp | string): R;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('swc worklets plugin', () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  // -------------------------------------------------------------------------
  // Generally
  // -------------------------------------------------------------------------

  describe('generally', () => {
    test('transforms', () => {
      const input = `
        import Animated, {
          useAnimatedStyle,
          useSharedValue,
        } from 'react-native-reanimated';

        function Box() {
          const offset = useSharedValue(0);

          const animatedStyles = useAnimatedStyle(() => {
            return {
              transform: [{ translateX: offset.value * 255 }],
            };
          });

          return (
            <>
              <Animated.View style={[styles.box, animatedStyles]} />
              <Button
                onPress={() => (offset.value = Math.random())}
                title="Move"
              />
            </>
          );
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('injects its version', () => {
      const input = `
        function foo() {
          'worklet';
          var foo = 'bar';
        }
      `;
      const { code } = runPlugin(input, { pluginVersion: '1.2.3' });
      expect(code).toMatch(/__pluginVersion\s*=\s*['"]1\.2\.3['"]/);
    });

    test('stamps "unknown" when pluginVersion is omitted', () => {
      const input = `
        function foo() {
          'worklet';
          var foo = 'bar';
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/__pluginVersion\s*=\s*['"]unknown['"]/);
    });

    test('uses relative source location when relativeSourceLocation is set to true', () => {
      const input = `
        function foo() {
          'worklet';
          var foo = 'bar';
        }
      `;
      const { code } = runPlugin(input, { relativeSourceLocation: true });
      expect(code).toBeDefined();
    });

    test('removes comments from worklets', () => {
      const input = `
        const f = () => {
          'worklet';
          // some comment
          /*
           * other comment
           */
          return true;
        };
      `;
      const { code } = runPlugin(input);
      expect(code).not.toContainInWorkletString('some comment');
      expect(code).not.toContainInWorkletString('other comment');
    });

    test('supports recursive calls', () => {
      const input = `
        const a = 1;
        function foo(t) {
          'worklet';
          if (t > 0) {
            return a + foo(t - 1);
          }
        }
      `;
      const { code } = runPlugin(input);
      // The upstream Babel-based assertion had no whitespace around `=`;
      // SWC's emitter pretty-prints with spaces, so we allow either form.
      expect(code).toMatch(/const foo_[A-Za-z0-9_]*\s*=\s*this\._recur;/);
    });
  });

  // -------------------------------------------------------------------------
  // Worklet names
  // -------------------------------------------------------------------------

  describe('for worklet names', () => {
    test('unnamed ArrowFunctionExpression', () => {
      const input = `
        () => {
          'worklet';
          return 1;
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/function null[0-9]+\s*\(\)/);
    });

    test('unnamed FunctionExpression', () => {
      const input = `
        [
          function () {
            'worklet';
            return 1;
          },
        ]();
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/function null[0-9]+\s*\(\)/);
    });

    test('names ObjectMethod with expression key', () => {
      const input = `
        const obj = {
          ['foo']() {
            'worklet';
          },
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('appends file name to function name', () => {
      const input = `
        function foo() {
          'worklet';
          return 1;
        }
      `;
      const { code } = runPlugin(input, { disableSourceMaps: true }, '/source.js');
      expect(code).toMatch(/function foo_sourceJs[0-9]+\s*\(/);
    });

    test('appends library name to function name', () => {
      const input = `
        function foo() {
          'worklet';
          return 1;
        }
      `;
      const { code } = runPlugin(
        input,
        { disableSourceMaps: true },
        '/node_modules/library/source.js',
      );
      expect(code).toMatch(/function foo_library_sourceJs[0-9]+\s*\(/);
    });

    test('handles names with illegal characters', () => {
      const input = `
        function foo() {
          'worklet';
          return 1;
        }
      `;
      const { code } = runPlugin(input, { disableSourceMaps: true }, '/-source.js');
      expect(code).toMatch(/function foo_SourceJs[0-9]+\s*\(/);
    });

    test('preserves recursion', () => {
      const input = `
        function foo() {
          'worklet';
          foo(1);
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/function foo_[A-Za-z0-9_]+\s*\(/);
      expect(code).toMatchInWorkletString(/function foo_[A-Za-z0-9_]+\(\)/);
    });
  });

  // -------------------------------------------------------------------------
  // Directive literals
  // -------------------------------------------------------------------------

  describe('for DirectiveLiterals', () => {
    test("doesn't bother other Directive Literals", () => {
      const input = `
        function foo() {
          'foobar';
          var foo = 'bar';
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('foobar');
    });

    test("doesn't transform functions without 'worklet' directive", () => {
      const input = `
        function f(x) {
          return x + 2;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test('removes "worklet" directive from worklets', () => {
      const input = `
        function foo(x) {
          "worklet";
          return x + 2;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).not.toContain('"worklet"');
      expect(code).not.toContain("'worklet'");
    });

    test("removes 'worklet' directive from worklets", () => {
      const input = `
        function foo(x) {
          'worklet';
          return x + 2;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).not.toContain("'worklet'");
      expect(code).not.toContain('"worklet"');
    });

    test("doesn't transform string literals", () => {
      const input = `
        function foo(x) {
          'worklet';
          const bar = 'worklet';
          const baz = "worklet";
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toContain("'worklet'");
      expect(code).toContain('"worklet"');
    });
  });

  // -------------------------------------------------------------------------
  // Closure capturing
  // -------------------------------------------------------------------------

  describe('for closure capturing', () => {
    test('captures worklets environment', () => {
      const input = `
        const x = 5;
        const objX = { x };

        function f() {
          'worklet';
          return { res: x + objX.x };
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/f\.__closure\s*=\s*\{[^}]*x[^}]*\}/);
      expect(code).toMatch(/f\.__closure\s*=\s*\{[^}]*objX[^}]*\}/);
    });

    test("doesn't capture default globals", () => {
      const input = `
        function f() {
          'worklet';
          console.log('test');
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/f\.__closure\s*=\s*\{\s*\}/);
    });

    test('implicitly captures globals with strictGlobal disabled', () => {
      const input = `
        function f() {
          'worklet';
          globalStuff();
        }
      `;
      const { code } = runPlugin(input, { strictGlobal: false });
      expect(code).toMatch(/f\.__closure\s*=\s*\{[^}]*globalStuff[^}]*\}/);
    });

    test("doesn't implicitly captures globals in strict mode", () => {
      const input = `
        function f() {
          'worklet';
          globalStuff();
        }
      `;
      const { code } = runPlugin(input, { strictGlobal: true });
      expect(code).toMatch(/f\.__closure\s*=\s*\{\s*\}/);
    });

    test('captures locally bound variables named like globals', () => {
      const input = `
        const console = {
          log: () => 42,
        };

        function f() {
          'worklet';
          console.log(console);
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/f\.__closure\s*=\s*\{[^}]*console[^}]*\}/);
    });

    test("doesn't capture custom globals", () => {
      const input = `
        function f() {
          'worklet';
          console.log(foo);
        }
      `;
      const { code } = runPlugin(input, { globals: ['foo'] });
      expect(code).toMatch(/f\.__closure\s*=\s*\{\s*\}/);
    });

    test("doesn't capture locally bound variables named like custom globals", () => {
      const input = `
        const foo = 1;
        function f() {
          'worklet';
          console.log(foo);
        }
      `;
      const { code } = runPlugin(input, { globals: ['foo'] });
      expect(code).toMatch(/f\.__closure\s*=\s*\{[^}]*foo[^}]*\}/);
    });

    test("doesn't capture arguments", () => {
      const input = `
        function f(a, b, c) {
          'worklet';
          console.log(a, b, c);
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/f\.__closure\s*=\s*\{\s*\}/);
    });

    test("doesn't capture objects' properties", () => {
      const input = `
        const foo = { bar: 42 };
        function f() {
          'worklet';
          console.log(foo.bar);
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/f\.__closure\s*=\s*\{[^}]*foo[^}]*\}/);
      expect(code).not.toMatch(/f\.__closure\s*=\s*\{[^}]*bar[^}]*\}/);
    });
  });

  // -------------------------------------------------------------------------
  // Explicit worklets
  // -------------------------------------------------------------------------

  describe('for explicit worklets', () => {
    test('workletizes FunctionDeclaration', () => {
      const input = `
        function foo(x) {
          'worklet';
          return x + 2;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).not.toContain("'worklet'");
    });

    test('workletizes ArrowFunctionExpression', () => {
      const input = `
        const foo = (x) => {
          'worklet';
          return x + 2;
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).not.toContain("'worklet'");
    });

    test('workletizes unnamed FunctionExpression', () => {
      const input = `
        const foo = function (x) {
          'worklet';
          return x + 2;
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).not.toContain("'worklet'");
    });

    test('workletizes named FunctionExpression', () => {
      const input = `
        const foo = function foo(x) {
          'worklet';
          return x + 2;
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).not.toContain("'worklet'");
    });

    test('workletizes ObjectMethod', () => {
      const input = `
        const foo = {
          bar(x) {
            'worklet';
            return x + 2;
          },
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });
  });

  // -------------------------------------------------------------------------
  // Class worklets
  //
  // Class members opening with a `'worklet'` directive are workletized:
  //   - Methods and class fields are rewritten to a factory-call expression.
  //   - Getters, setters and constructors keep their syntactic shape; the
  //     factory runs as a side effect so `init_data` still lands at module
  //     scope (accessor bodies themselves are NOT rewired — see the plugin
  //     docs for the implications).
  // -------------------------------------------------------------------------

  describe('for class worklets', () => {
    test('workletizes instance method', () => {
      const input = `
        class Foo {
          bar() { 'worklet'; return 1; }
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).not.toContain("'worklet'");
    });

    test('workletizes static method', () => {
      const input = `
        class Foo {
          static bar() { 'worklet'; return 1; }
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).toMatch(/static\s+bar\s*=/);
    });

    test('workletizes getter', () => {
      const input = `
        class Foo {
          get bar() { 'worklet'; return 1; }
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).not.toContain("'worklet'");
    });

    test('workletizes setter', () => {
      const input = `
        class Foo {
          set bar(v) { 'worklet'; this._v = v; }
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).not.toContain("'worklet'");
    });

    test('workletizes class field', () => {
      const input = `
        class Foo {
          bar = () => { 'worklet'; return 1; };
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).not.toContain("'worklet'");
    });

    test('workletizes static class field', () => {
      const input = `
        class Foo {
          static bar = () => { 'worklet'; return 1; };
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).toMatch(/static\s+bar\s*=/);
    });

    test('workletizes constructor', () => {
      const input = `
        class Foo {
          constructor() { 'worklet'; this.x = 1; }
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).not.toContain("'worklet'");
    });
  });

  // -------------------------------------------------------------------------
  // Function hooks
  // -------------------------------------------------------------------------

  describe('for function hooks', () => {
    test('workletizes hook wrapped ArrowFunctionExpression automatically', () => {
      const input = `
        const animatedStyle = useAnimatedStyle(() => ({ width: 50 }));
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes hook wrapped unnamed FunctionExpression automatically', () => {
      const input = `
        const animatedStyle = useAnimatedStyle(function () {
          return { width: 50 };
        });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes hook wrapped named FunctionExpression automatically', () => {
      const input = `
        const animatedStyle = useAnimatedStyle(function foo() {
          return { width: 50 };
        });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes hook wrapped worklet reference automatically', () => {
      const input = `
        const style = () => ({ color: 'red', backgroundColor: 'blue' });
        const animatedStyle = useAnimatedStyle(style);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes useDerivedValue', () => {
      const input = `
        const x = useDerivedValue(() => sharedValue.value * 2);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes runOnUI', () => {
      const input = `
        runOnUI(() => { console.log('hello'); })();
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes withTiming callback (3rd argument)', () => {
      const input = `
        withTiming(100, {}, () => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes useAnimatedReaction dependencies and handler', () => {
      const input = `
        useAnimatedReaction(
          () => shared.value,
          (current) => { console.log(current); }
        );
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(2);
    });
  });

  // -------------------------------------------------------------------------
  // Object hooks
  // -------------------------------------------------------------------------

  describe('for object hooks', () => {
    test('workletizes useAnimatedScrollHandler wrapped ArrowFunctionExpression automatically', () => {
      const input = `
        useAnimatedScrollHandler({
          onScroll: (event) => { console.log(event); },
        });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes useAnimatedScrollHandler wrapped unnamed FunctionExpression automatically', () => {
      const input = `
        useAnimatedScrollHandler({
          onScroll: function (event) { console.log(event); },
        });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes useAnimatedScrollHandler wrapped named FunctionExpression automatically', () => {
      const input = `
        useAnimatedScrollHandler({
          onScroll: function onScroll(event) { console.log(event); },
        });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes useAnimatedScrollHandler wrapped ObjectMethod automatically', () => {
      const input = `
        useAnimatedScrollHandler({
          onScroll(event) { console.log(event); },
        });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('supports empty object in useAnimatedScrollHandler', () => {
      const input = `useAnimatedScrollHandler({});`;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test('transforms each object property in useAnimatedScrollHandler', () => {
      const input = `
        useAnimatedScrollHandler({
          onScroll: () => {},
          onBeginDrag: () => {},
          onEndDrag: () => {},
          onMomentumBegin: () => {},
          onMomentumEnd: () => {},
        });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(5);
    });

    test('transforms ArrowFunctionExpression as argument of useAnimatedScrollHandler', () => {
      const input = `
        useAnimatedScrollHandler((event) => { console.log(event); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('transforms unnamed FunctionExpression as argument of useAnimatedScrollHandler', () => {
      const input = `
        useAnimatedScrollHandler(function (event) { console.log(event); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('transforms named FunctionExpression as argument of useAnimatedScrollHandler', () => {
      const input = `
        useAnimatedScrollHandler(function onScroll(event) { console.log(event); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });
  });

  // -------------------------------------------------------------------------
  // Gesture handler
  // -------------------------------------------------------------------------

  describe('for react-native-gesture-handler', () => {
    test('workletizes gesture callbacks using the hooks api', () => {
      const input = `
        const pan = useTapGesture({
          onStart: () => { console.log('start'); },
          onEnd: () => { console.log('end'); },
        });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(2);
    });

    test('workletizes referenced gesture callbacks using the hooks api', () => {
      const input = `
        const onStart = () => { console.log('start'); };
        const onEnd = () => { console.log('end'); };
        const pan = useTapGesture({ onStart, onEnd });
      `;
      const { code } = runPlugin(input);
      // Both referenced callbacks resolve to their own var decls and get
      // workletized; the object-method-style shorthand is handled because
      // `force_workletize_obj` sees through `Prop::Shorthand`.
      expect(code).toHaveWorkletData(2);
    });

    test('workletizes referenced gesture callbacks using the hooks api and shorthand syntax', () => {
      const input = `
        const onStart = () => { console.log('start'); };
        const pan = useTapGesture({ onStart });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes possibly chained gesture object callback functions automatically', () => {
      const input = `
        const foo = Gesture.Tap()
          .onBegin(() => { console.log('begin'); })
          .onEnd(() => { console.log('end'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(2);
    });

    test("doesn't workletize irrelevant chained gesture object callback functions", () => {
      const input = `
        const foo = Gesture.Tap().somethingElse(() => { console.log('x'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test("doesn't transform standard callback functions", () => {
      const input = `
        const foo = Something.Tap().onEnd(() => { console.log('end'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test("doesn't transform chained methods of objects containing Gesture property", () => {
      const input = `
        const foo = Something.Gesture.Tap().onEnd(() => { console.log('end'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test('transforms spread operator in worklets for arrays', () => {
      const input = `
        function foo() {
          'worklet';
          const bar = [4, 5];
          const baz = [1, ...[2, 3], ...bar];
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('...bar');
    });

    test('transforms spread operator in worklets for objects', () => {
      const input = `
        function foo() {
          'worklet';
          const bar = { d: 4, e: 5 };
          const baz = { a: 1, ...{ b: 2, c: 3 }, ...bar };
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('...bar');
    });

    test('transforms spread operator in worklets for function arguments', () => {
      const input = `
        function foo(...args) {
          'worklet';
          console.log(args);
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('...args');
    });

    test('transforms spread operator in worklets for function calls', () => {
      const input = `
        function foo(arg) {
          'worklet';
          console.log(...arg);
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('...arg');
    });

    test('transforms spread operator in Animated component', () => {
      const input = `
        function App() {
          return (
            <Animated.View
              style={[style, { ...styles.container, width: sharedValue.value }]}
            />
          );
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('...styles.container');
    });

    test('workletizes referenced callbacks', () => {
      const input = `
        const onStart = () => {};
        const foo = Gesture.Tap().onStart(onStart);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });
  });

  // -------------------------------------------------------------------------
  // Sequence expressions
  //
  // A hook argument wrapped in a comma operator — `((a, b, lastExpr))` —
  // evaluates `a` and `b` for side effects, then yields `lastExpr`. The
  // plugin sees through the sequence and workletizes only the trailing
  // expression, matching what actually reaches the hook at runtime.
  // -------------------------------------------------------------------------

  describe('for sequence expressions', () => {
    test('supports SequenceExpression', () => {
      const input = `
        const animatedStyle = useAnimatedStyle((0, () => ({ width: 1 })));
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('supports SequenceExpression, with objectHook', () => {
      const input = `
        useAnimatedScrollHandler(
          (0, { onScroll: (event) => { console.log(event); } }),
        );
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('supports SequenceExpression, with worklet', () => {
      const input = `
        const fn = (0, function () {
          'worklet';
          return 1;
        });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('supports SequenceExpression, many arguments', () => {
      const input = `
        const animatedStyle = useAnimatedStyle(
          (a(), b(), c(), () => ({ width: 1 })),
        );
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('supports SequenceExpression, with worklet closure', () => {
      const input = `
        const outer = 42;
        const animatedStyle = useAnimatedStyle(
          (0, () => ({ width: outer })),
        );
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/__closure\s*=\s*\{[^}]*outer[^}]*\}/);
    });
  });

  // -------------------------------------------------------------------------
  // Inline styles
  // -------------------------------------------------------------------------

  describe('for inline styles', () => {
    test('shows a warning if user uses .value inside inline style', () => {
      const input = `
        function App() {
          return <Animated.View style={{ width: sharedValue.value }} />;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveInlineStyleWarning();
    });

    test("doesn't show a warning if the user uses ['value'] inside inline style", () => {
      const input = `
        function App() {
          return <Animated.View style={{ width: object['value'] }} />;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveInlineStyleWarning(0);
    });

    test("doesn't show a warning if the user uses [value] inside inline style", () => {
      const input = `
        function App() {
          return <Animated.View style={{ width: object[value] }} />;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveInlineStyleWarning(0);
    });

    test('shows a warning if user uses .value inside inline style, style array', () => {
      const input = `
        function App() {
          return <Animated.View style={[style, { width: sharedValue.value }]} />;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveInlineStyleWarning();
    });

    test('shows a warning if user uses .value inside inline style, transforms', () => {
      const input = `
        function App() {
          return <Animated.View style={{ transform: [{ translateX: sharedValue.value }] }} />;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveInlineStyleWarning();
    });

    test("doesn't show a warning if user writes something like style={styles.value}", () => {
      const input = `
        function App() {
          return <Animated.View style={styles.value} />;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveInlineStyleWarning(0);
    });

    test("doesn't show a warning when disableInlineStylesWarning is set", () => {
      const input = `
        function App() {
          return <Animated.View style={{ width: sharedValue.value }} />;
        }
      `;
      const { code } = runPlugin(input, { disableInlineStylesWarning: true });
      expect(code).toHaveInlineStyleWarning(0);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe('is idempotent', () => {
    function isIdempotent(input: string, opts: PluginOptions = {}) {
      const first = runPlugin(input, opts).code;
      const second = runPlugin(first, opts).code;
      return first === second;
    }

    test('for common cases', () => {
      const input1 = `
        const foo = useAnimatedStyle(() => { const x = 1; });
      `;
      expect(isIdempotent(input1)).toBe(true);

      const input2 = `
        const foo = useAnimatedStyle(() => {
          const bar = useAnimatedStyle(() => { const x = 1; });
        });
      `;
      expect(isIdempotent(input2)).toBe(true);

      const input3 = `
        const foo = useAnimatedStyle(function named() {
          const bar = useAnimatedStyle(function named() { const x = 1; });
        });
      `;
      expect(isIdempotent(input3)).toBe(true);

      const input4 = `
        const foo = (x) => {
          return () => { 'worklet'; return x; };
        };
      `;
      expect(isIdempotent(input4)).toBe(true);

      const input5 = `
        const foo = useAnimatedStyle({
          method() { 'worklet'; const x = 1; },
        });
      `;
      expect(isIdempotent(input5)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Layout animations
  // -------------------------------------------------------------------------

  describe('for Layout Animations', () => {
    test('workletizes unchained callback functions automatically', () => {
      const input = `
        FadeIn.withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes unchained callback functions automatically with new keyword', () => {
      const input = `
        new FadeIn().withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test("doesn't workletize callback functions on unknown objects", () => {
      const input = `
        AmogusIn.withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test("doesn't workletize callback functions on unknown objects with new keyword", () => {
      const input = `
        new AmogusIn().withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test('workletizes callback functions on known chained methods before', () => {
      const input = `
        FadeIn.build().duration(500).withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes callback functions on known chained methods before with new keyword', () => {
      const input = `
        new FadeIn().build().duration(500).withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test("doesn't workletize callback functions on unknown objects on known chained methods before", () => {
      const input = `
        AmogusIn.build().withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test("doesn't workletize callback functions on unknown objects on known chained methods before with new keyword", () => {
      const input = `
        new AmogusIn().build().withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test('workletizes callback functions on known chained methods after', () => {
      const input = `
        FadeIn.withCallback(() => { console.log('done'); }).build();
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes callback functions on known chained methods after with new keyword', () => {
      const input = `
        new FadeIn().withCallback(() => { console.log('done'); }).build();
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test("doesn't workletize callback functions on unknown chained methods before", () => {
      const input = `
        FadeIn.AmogusIn().withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test("doesn't workletize callback functions on unknown chained methods before with new keyword", () => {
      const input = `
        new FadeIn().AmogusIn().withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test("doesn't workletize callback functions on unknown objects chained with known objects", () => {
      const input = `
        AmogusIn.FadeIn().withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test("doesn't workletize callback functions on unknown objects chained with known objects with new keyword", () => {
      const input = `
        new AmogusIn().FadeIn().withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test('workletizes callback functions on unknown objects chained after', () => {
      const input = `
        FadeIn.withCallback(() => { console.log('done'); }).AmogusIn();
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes callback functions on unknown objects chained after with new keyword', () => {
      const input = `
        new FadeIn().withCallback(() => { console.log('done'); }).AmogusIn();
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test("doesn't workletize callback functions on unknown objects with known object chained after", () => {
      const input = `
        AmogusIn.withCallback(() => { console.log('done'); }).FadeIn();
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test("doesn't workletize callback functions on unknown objects with known object chained after with new keyword", () => {
      const input = `
        new AmogusIn().withCallback(() => { console.log('done'); }).FadeIn();
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(0);
    });

    test('workletizes callback functions on longer chains of known objects', () => {
      const input = `
        FadeIn.build().duration(500).delay(100).withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes callback functions on longer chains of known objects with new keyword', () => {
      const input = `
        new FadeIn().build().duration(500).delay(100).withCallback(() => { console.log('done'); });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });
  });

  // -------------------------------------------------------------------------
  // Debugging
  // -------------------------------------------------------------------------

  describe('for debugging', () => {
    test('does inject location for worklets in dev builds', () => {
      const input = `
        const foo = useAnimatedStyle(() => { const x = 1; });
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveLocation(MOCK_LOCATION);
    });

    test("doesn't inject location for worklets in production builds", () => {
      process.env.NODE_ENV = 'production';
      const input = `
        const foo = useAnimatedStyle(() => { const x = 1; });
      `;
      const { code } = runPlugin(input);
      expect(code).not.toHaveLocation(MOCK_LOCATION);
    });

    test("doesn't inject version for worklets in production builds", () => {
      process.env.NODE_ENV = 'production';
      const input = `
        const foo = useAnimatedStyle(() => { const x = 1; });
      `;
      const { code } = runPlugin(input);
      expect(code).not.toContain('__pluginVersion');
    });
  });

  // -------------------------------------------------------------------------
  // Worklet nesting
  // -------------------------------------------------------------------------

  describe('for worklet nesting', () => {
    test('transpiles nested worklets', () => {
      const input = `
        const foo = () => {
          'worklet';
          const bar = () => {
            'worklet';
            console.log('bar');
          };
          bar();
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(2);
    });

    test('transpiles nested worklets with depth 3', () => {
      const input = `
        const foo = () => {
          'worklet';
          const bar = () => {
            'worklet';
            const foobar = () => {
              'worklet';
              console.log('foobar');
            };
          };
          bar();
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(3);
    });

    test('transpiles nested worklets embedded in runOnJS in runOnUI', () => {
      const input = `
        runOnUI(() => {
          console.log('Hello from UI thread');
          runOnJS(() => {
            'worklet';
            console.log('Hello from JS thread');
          })();
        })();
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(2);
    });

    test('transpiles nested worklets embedded in runOnUI in runOnJS in runOnUI', () => {
      const input = `
        runOnUI(() => {
          console.log('Hello from UI thread');
          runOnJS(() => {
            'worklet';
            console.log('Hello from JS thread');
            runOnUI(() => {
              console.log('Hello from UI thread again');
            })();
          })();
        })();
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(3);
    });
  });

  // Web-only options (`omitNativeOnlyData`, `substituteWebPlatformChecks`)
  // were removed — this plugin targets native (iOS/Android) only.

  // -------------------------------------------------------------------------
  // Generators
  // -------------------------------------------------------------------------

  describe('for generators', () => {
    test('makes a generator worklet factory', () => {
      const input = `
        function* foo() {
          'worklet';
          yield 'hello';
          yield 'world';
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/function\s*\*/);
      expect(code).toHaveWorkletData();
    });

    test('makes a generator worklet string', () => {
      const input = `
        function* foo() {
          'worklet';
          yield 'hello';
          yield 'world';
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatchInWorkletString(/function\s*\*\s*foo_[A-Za-z0-9_]+/);
    });
  });

  // -------------------------------------------------------------------------
  // Async functions
  // -------------------------------------------------------------------------

  describe('for async functions', () => {
    test('makes an async worklet factory', () => {
      const input = `
        async function foo() {
          'worklet';
          await Promise.resolve();
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/async\s+function/);
      expect(code).toHaveWorkletData();
    });

    test('makes an async worklet string', () => {
      const input = `
        async function foo() {
          'worklet';
          await Promise.resolve();
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toMatchInWorkletString(/async function foo_[A-Za-z0-9_]+/);
    });
  });

  // -------------------------------------------------------------------------
  // Referenced worklets
  //
  // When a hook call receives an identifier rather than an inline function,
  // the binding it resolves to is located and tagged for workletization.
  // Binding priority (mirrors upstream reanimated / Babel scope rules):
  //     FunctionDeclaration  >  last AssignmentExpression  >  VariableDeclarator init
  // Resolution is order-insensitive: the hook call may appear before the
  // binding that it references.
  // -------------------------------------------------------------------------

  describe('for referenced worklets', () => {
    test('workletizes ArrowFunctionExpression on its VariableDeclarator', () => {
      const input = `
        const foo = () => ({ width: 50 });
        const animatedStyle = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ArrowFunctionExpression on its AssignmentExpression', () => {
      const input = `
        let foo;
        foo = () => ({ width: 50 });
        const animatedStyle = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ArrowFunctionExpression only on last AssignmentExpression', () => {
      const input = `
        let foo = () => ({ width: 1 });
        foo = () => ({ width: 2 });
        const animatedStyle = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      // Only the last assignment becomes a factory call; the initial decl's
      // arrow stays a plain arrow.
      expect(code).toHaveWorkletData(1);
    });

    test('workletizes FunctionExpression on its VariableDeclarator', () => {
      const input = `
        const foo = function () { return 1; };
        const animatedStyle = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes FunctionExpression on its AssignmentExpression', () => {
      const input = `
        let foo;
        foo = function () { return 1; };
        const animatedStyle = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes FunctionExpression only on last AssignmentExpression', () => {
      const input = `
        let foo = function () { return 1; };
        foo = function () { return 2; };
        const animatedStyle = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(1);
    });

    test('workletizes FunctionDeclaration', () => {
      const input = `
        function foo() { return 1; }
        const animatedStyle = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ObjectExpression on its VariableDeclarator', () => {
      const input = `
        const handler = { onScroll: (e) => { console.log(e); } };
        useAnimatedScrollHandler(handler);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ObjectExpression on its AssignmentExpression', () => {
      const input = `
        let handler;
        handler = { onScroll: (e) => { console.log(e); } };
        useAnimatedScrollHandler(handler);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ObjectExpression only on last AssignmentExpression', () => {
      const input = `
        let handler = { onScroll: (e) => 1 };
        handler = { onScroll: (e) => 2 };
        useAnimatedScrollHandler(handler);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(1);
    });

    test('prefers FunctionDeclaration over AssignmentExpression', () => {
      const input = `
        function foo() { return 1; }
        foo = function () { return 2; };
        const animatedStyle = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      // Only the FunctionDeclaration gets workletized, not the reassignment.
      expect(code).toHaveWorkletData(1);
    });

    test('prefers AssignmentExpression over VariableDeclarator', () => {
      const input = `
        let foo = () => 1;
        foo = () => 2;
        const animatedStyle = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      // Only the assignment's RHS becomes a factory call; the original var
      // decl's arrow stays plain.
      expect(code).toHaveWorkletData(1);
    });

    test('workletizes in immediate scope', () => {
      const input = `
        const foo = () => ({ width: 50 });
        const animatedStyle = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes in nested scope', () => {
      const input = `
        function Component() {
          const foo = () => ({ width: 50 });
          const animatedStyle = useAnimatedStyle(foo);
          return animatedStyle;
        }
      `;
      const { code } = runPlugin(input);
      // The reference-tagger walks every statement it encounters, so the
      // hook call inside \`Component\` still finds \`foo\` and tags it.
      expect(code).toHaveWorkletData();
    });

    test('workletizes assignments that appear after the worklet is used', () => {
      const input = `
        useAnimatedStyle(foo);
        function foo() { return 1; }
      `;
      const { code } = runPlugin(input);
      // Binding resolution is order-insensitive — the FunctionDeclaration
      // is still found and workletized even though it appears after the use.
      expect(code).toHaveWorkletData();
    });

    test('workletizes multiple referencing', () => {
      const input = `
        const foo = () => ({ width: 50 });
        const a = useAnimatedStyle(foo);
        const b = useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      // Two hook calls both resolve to the same binding; the binding is
      // tagged once (idempotent) and workletized into a single factory.
      expect(code).toHaveWorkletData();
    });

    test('workletizes recursion', () => {
      const input = `
        function foo(t) {
          if (t > 0) return foo(t - 1);
          return 0;
        }
        useAnimatedStyle(foo);
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).toMatch(/const foo_[A-Za-z0-9_]*\s*=\s*this\._recur;/);
    });
  });

  // -------------------------------------------------------------------------
  // File workletization — top-level `'worklet';` directive applies to every
  // function/method in the file.
  // -------------------------------------------------------------------------

  describe('for file workletization', () => {
    test('workletizes FunctionDeclaration', () => {
      const input = `
        'worklet';
        function foo() {
          return 1;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes assigned FunctionDeclaration', () => {
      const input = `
        'worklet';
        const foo = function () {
          return 1;
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes FunctionDeclaration in named export', () => {
      const input = `
        'worklet';
        export function foo() {
          return 1;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes FunctionDeclaration in default export', () => {
      const input = `
        'worklet';
        export default function foo() {
          return 1;
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes FunctionExpression', () => {
      const input = `
        'worklet';
        const foo = function () { return 1; };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes FunctionExpression in named export', () => {
      const input = `
        'worklet';
        export const foo = function () { return 1; };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes FunctionExpression in default export', () => {
      const input = `
        'worklet';
        export default function () { return 1; };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ArrowFunctionExpression', () => {
      const input = `
        'worklet';
        const foo = () => 1;
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ArrowFunctionExpression in named export', () => {
      const input = `
        'worklet';
        export const foo = () => 1;
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ArrowFunctionExpression in default export', () => {
      const input = `
        'worklet';
        export default () => 1;
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ObjectMethod', () => {
      const input = `
        'worklet';
        const obj = { m() { return 1; } };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ObjectMethod in named export', () => {
      const input = `
        'worklet';
        export const obj = { m() { return 1; } };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ObjectMethod in default export', () => {
      const input = `
        'worklet';
        export default { m() { return 1; } };
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes implicit WorkletContextObject', () => {
      // A method referencing `this` signals an implicit context object:
      // the whole thing is wrapped as one worklet (preserving `this`)
      // rather than each method becoming its own worklet.
      const input = `
        'worklet';
        const ctx = { x: 1, m() { return this.x; } };
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('__workletContextObjectFactory');
      expect(code).toHaveWorkletData();
    });

    test('workletizes implicit WorkletContextObject in named export', () => {
      const input = `
        'worklet';
        export const ctx = { x: 1, m() { return this.x; } };
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('__workletContextObjectFactory');
      expect(code).toHaveWorkletData();
    });

    test('workletizes implicit WorkletContextObject in default export', () => {
      const input = `
        'worklet';
        export default { x: 1, m() { return this.x; } };
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('__workletContextObjectFactory');
      expect(code).toHaveWorkletData();
    });

    test('workletizes ClassDeclaration', () => {
      const input = `
        'worklet';
        class Foo { m() { return 1; } }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ClassDeclaration in named export', () => {
      const input = `
        'worklet';
        export class Foo { m() { return 1; } }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes ClassDeclaration in default export', () => {
      const input = `
        'worklet';
        export default class Foo { m() { return 1; } }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
    });

    test('workletizes multiple functions', () => {
      const input = `
        'worklet';
        function a() { return 1; }
        function b() { return 2; }
        const c = () => 3;
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData(3);
    });

    test("doesn't workletize function outside of top level scope", () => {
      const input = `
        'worklet';
        function outer() {
          function inner() { return 1; }
        }
      `;
      const { code } = runPlugin(input);
      // Only outer is workletized; inner is untouched inside outer.
      expect(code).toHaveWorkletData(1);
    });

    test('moves CommonJS export to the bottom of the file', () => {
      // Under a file-level `'worklet';` directive, top-level function and
      // class declarations are rewritten to `const`-bound factory calls,
      // which (unlike hoisted function declarations) are not yet defined
      // at the top of the file. Moving CJS exports to the bottom keeps
      // them observing the fully-initialized bindings.
      const input = `
        'worklet';
        module.exports = foo;
        function foo() { return 1; }
      `;
      const { code } = runPlugin(input);
      const exportIdx = code.indexOf('module.exports');
      const declIdx = code.indexOf('const foo =');
      expect(exportIdx).toBeGreaterThan(-1);
      expect(declIdx).toBeGreaterThan(-1);
      expect(exportIdx).toBeGreaterThan(declIdx);
    });

    test('moves multiple CommonJS exports to the bottom of the file', () => {
      const input = `
        'worklet';
        module.exports.a = a;
        exports.b = b;
        Object.defineProperty(exports, 'c', { value: c });
        function a() { return 1; }
        function b() { return 2; }
        function c() { return 3; }
      `;
      const { code } = runPlugin(input);
      const moduleExportsIdx = code.indexOf('module.exports');
      const exportsDotBIdx = code.indexOf('exports.b');
      const definePropIdx = code.indexOf('Object.defineProperty(exports');
      const lastDeclIdx = code.lastIndexOf('const c =');
      expect(moduleExportsIdx).toBeGreaterThan(lastDeclIdx);
      expect(exportsDotBIdx).toBeGreaterThan(lastDeclIdx);
      expect(definePropIdx).toBeGreaterThan(lastDeclIdx);
    });
  });

  // -------------------------------------------------------------------------
  // Context objects
  //
  // An object literal with the `__workletContextObject` marker is expanded
  // into a plain object plus a `__workletContextObjectFactory` method that
  // returns a worklet clone of the object. The marker's *presence* triggers
  // the transform — its value is ignored — matching upstream reanimated.
  // -------------------------------------------------------------------------

  describe('for context objects', () => {
    test('removes marker', () => {
      const input = `
        const ctx = {
          __workletContextObject: true,
          x: 1,
        };
      `;
      const { code } = runPlugin(input);
      expect(code).not.toContain('__workletContextObject:');
    });

    test('creates factories', () => {
      const input = `
        const ctx = {
          __workletContextObject: true,
          x: 1,
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('__workletContextObjectFactory');
      expect(code).toHaveWorkletData();
    });

    test('workletizes regardless of marker value', () => {
      const input = `
        const ctx = {
          __workletContextObject: false,
          x: 1,
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toContain('__workletContextObjectFactory');
      expect(code).toHaveWorkletData();
    });

    test('preserves bindings', () => {
      const input = `
        const outer = 42;
        const ctx = {
          __workletContextObject: true,
          m() { return outer; },
        };
      `;
      const { code } = runPlugin(input);
      expect(code).toMatch(/__workletContextObjectFactory\.__closure\s*=\s*\{[^}]*outer[^}]*\}/);
    });
  });

  // -------------------------------------------------------------------------
  // Worklet classes
  //
  // A class-level `__workletClass` marker property opts every method in the
  // class into workletization (matching upstream reanimated). Marker
  // *presence* triggers the transform — its value is ignored.
  // -------------------------------------------------------------------------

  describe('for worklet classes', () => {
    test('removes marker', () => {
      const input = `
        class Foo {
          __workletClass = true;
          m() { return 1; }
        }
      `;
      const { code } = runPlugin(input);
      expect(code).not.toContain('__workletClass');
    });

    test('creates factories', () => {
      const input = `
        class Foo {
          __workletClass = true;
          m() { return 1; }
          n() { return 2; }
        }
      `;
      const { code } = runPlugin(input);
      // Two methods → two worklet factories.
      expect(code).toHaveWorkletData(2);
    });

    test('workletizes regardless of marker value', () => {
      const input = `
        class Foo {
          __workletClass = false;
          m() { return 1; }
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      expect(code).not.toContain('__workletClass');
    });

    // Class polyfill / class-factory injection into worklet closures is
    // handled by the outer SWC transform (`HERMES_ENV_INCLUDE` in
    // `@react-native-swc/core/src/swc.ts` runs `transform-classes` etc.), not by
    // this plugin — so the upstream Reanimated tests that exercise Babel's
    // mid-transform class pipeline don't map onto our architecture.

    test('keeps this binding', () => {
      const input = `
        class Foo {
          __workletClass = true;
          x = 1;
          m() { return this.x; }
        }
      `;
      const { code } = runPlugin(input);
      expect(code).toHaveWorkletData();
      // The workletized method body still references \`this.x\` (\`this\` is
      // routed to the class instance by the worklet runtime).
      expect(code).toContainInWorkletString('this.x');
    });

    test('is disabled via option', () => {
      const input = `
        class Foo {
          __workletClass = true;
          m() { return 1; }
        }
      `;
      const { code } = runPlugin(input, { disableWorkletClasses: true });
      // With the option on, the class is left untouched — marker kept,
      // methods not wrapped.
      expect(code).toContain('__workletClass');
      expect(code).toHaveWorkletData(0);
    });
  });
});
