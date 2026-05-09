/**
 * Ported from metro/packages/metro-transform-plugins/src/__tests__/inline-plugin-test.js
 *
 * The upstream Babel-based tests compose `inlinePlugin` with the flow-strip
 * plugin for two cases. Since SWC parses Flow syntax only via the TS parser
 * preset, we drop those two cases (they test @babel/plugin-transform-flow-strip
 * compatibility, not the inline plugin itself).
 */

import { compareInline, compareInlineThenFold } from './test-helpers';

describe('inline constants', () => {
  test('replaces Platform.OS in the code if Platform is a global', () => {
    const code = `
      function a() {
        var a = Platform.OS;
        var b = a.Platform.OS;
      }
    `;

    compareInline(code, code.replace(/Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces Platform.OS in the code if Platform is a top level import', () => {
    const code = `
      var Platform = require('Platform');

      function a() {
        if (Platform.OS === 'android') {
          a = function() {};
        }

        var b = a.Platform.OS;
      }
    `;

    compareInline(code, code.replace(/Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces Platform.OS in the code if Platform is a top level import from react-native', () => {
    const code = `
      var Platform = require('react-native').Platform;

      function a() {
        if (Platform.OS === 'android') {
          a = function() {};
        }

        var b = a.Platform.OS;
      }
    `;

    compareInline(code, code.replace(/Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces require("Platform").OS in the code', () => {
    const code = `
      function a() {
        var a = require('Platform').OS;
        var b = a.require('Platform').OS;
      }
    `;

    compareInline(code, code.replace(/require\('Platform'\)\.OS/, '"android"'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('replaces React.Platform.OS in the code if React is a global', () => {
    const code = `
      function a() {
        var a = React.Platform.OS;
        var b = a.React.Platform.OS;
      }
    `;

    compareInline(code, code.replace(/React\.Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces ReactNative.Platform.OS in the code if ReactNative is a global', () => {
    const code = `
      function a() {
        var a = ReactNative.Platform.OS;
        var b = a.ReactNative.Platform.OS;
      }
    `;

    compareInline(code, code.replace(/ReactNative\.Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces React.Platform.OS in the code if React is a top level import', () => {
    const code = `
      var React = require('React');

      function a() {
        if (React.Platform.OS === 'android') {
          a = function() {};
        }

        var b = a.React.Platform.OS;
      }
    `;

    compareInline(code, code.replace(/React\.Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces require("React").Platform.OS in the code', () => {
    const code = `
      function a() {
        var a = require('React').Platform.OS;
        var b = a.require('React').Platform.OS;
      }
    `;

    compareInline(code, code.replace(/require\('React'\)\.Platform\.OS/, '"android"'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('replaces ReactNative.Platform.OS in the code if ReactNative is a top level import', () => {
    const code = `
      var ReactNative = require('react-native');

      function a() {
        if (ReactNative.Platform.OS === 'android') {
          a = function() {};
        }

        var b = a.ReactNative.Platform.OS;
      }
    `;

    compareInline(code, code.replace(/ReactNative\.Platform\.OS/, '"android"'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('replaces require("react-native").Platform.OS in the code', () => {
    const code = `
      function a() {
        var a = require('react-native').Platform.OS;
        var b = a.require('react-native').Platform.OS;
      }
    `;

    compareInline(code, code.replace(/require\('react-native'\)\.Platform\.OS/, '"android"'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('replaces _arbitraryName.Platform.OS when _arbitraryName is bound to require("react-native")', () => {
    const code = `
      var _reactNative = require('react-native');

      function a() {
        if (_reactNative.Platform.OS === 'android') {
          a = function() {};
        }

        var b = a._reactNative.Platform.OS;
      }
    `;

    compareInline(code, code.replace(/_reactNative\.Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('inlines Platform.select in the code if Platform is a global and the argument is an object literal', () => {
    const code = `
      function a() {
        var a = Platform.select({ios: 1, android: 2});
        var b = a.Platform.select({ios: 1, android: 2});
      }
    `;

    compareInline(code, code.replace(/Platform\.select[^;]+/, '1'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test("inlines Platform.select in the code if Platform is a global and the argument doesn't have a target platform in its keys", () => {
    const code = `
      function a() {
        var a = Platform.select({ios: 1, default: 2});
        var b = a.Platform.select({ios: 1, default: 2});
      }
    `;

    compareInline(code, code.replace(/Platform\.select[^;]+/, '2'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test("inlines Platform.select in the code if Platform is a global and the argument doesn't have a target platform in its keys but has native", () => {
    const code = `
      function a() {
        var a = Platform.select({ios: 1, native: 2});
        var b = a.Platform.select({ios: 1, native: 2});
      }
    `;

    compareInline(code, code.replace(/Platform\.select[^;]+/, '2'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test("doesn't inline Platform.select in the code if Platform is a global and the argument only has an unknown platform in its keys", () => {
    const code = `
      function a() {
        var a = Platform.select({web: 2});
        var b = a.Platform.select({native: 2});
      }
    `;

    compareInline(code, code.replace(/Platform\.select[^;]+/, 'undefined'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('inlines Platform.select in the code when using string keys', () => {
    const code = `
      function a() {
        var a = Platform.select({'ios': 1, 'android': 2});
      }
    `;

    compareInline(code, code.replace(/Platform\.select[^;]+/, '2'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('inlines Platform.select in the code when using an ObjectMethod', () => {
    const code = `
      function a() {
        var a = Platform.select({
          ios() { return 1; },
          async* android(a, b) { return 2; },
        });
      }
    `;
    const expected = `
      function a() {
        var a = async function*(a, b) { return 2; };
      }
    `;
    compareInline(code, expected, {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('inlines Platform.select in the code when using an ObjectMethod with string keys', () => {
    const code = `
      function a() {
        var a = Platform.select({
          "ios"() { return 1; },
          "android"() { return 2; },
        });
      }
    `;
    const expected = `
      function a() {
        var a = function() { return 2; };
      }
    `;
    compareInline(code, expected, {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('does not inline Platform.select in the code when some of the properties are dynamic', () => {
    const code = `
      function a() {
        const COMPUTED_IOS = 'ios';
        const COMPUTED_ANDROID = 'android';
        var a = Platform.select({[COMPUTED_ANDROID]: 1, [COMPUTED_IOS]: 2, default: 3});
      }
    `;

    compareInline(code, code, {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('does not inline Platform.select when all properties are dynamic', () => {
    const code = `
      function a() {
        var a = Platform.select({[COMPUTED_ANDROID]: 1, [COMPUTED_IOS]: 2});
      }
    `;

    compareInline(code, code, {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('does not inline Platform.select when ObjectMethod properties are dynamic', () => {
    const code = `
      function a() {
        const COMPUTED_IOS = 'ios';
        const COMPUTED_ANDROID = 'android';
        var a = Platform.select({[COMPUTED_ANDROID]() {}, [COMPUTED_IOS]() {}});
      }
    `;

    compareInline(code, code, {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('does not inline Platform.select when the object has a getter or setter', () => {
    const code = `
      function a() {
        var a = Platform.select({
          get ios() {},
          get android() {},
        });
      }
    `;

    compareInline(code, code, {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('does not inline Platform.select when the object has a spread', () => {
    const code = `
      function a() {
        var a = Platform.select({
          ...ios,
          ...android,
        });
      }
    `;

    compareInline(code, code, {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('does not inline Platform.select if it receives a non-object', () => {
    const code = `
      function a() {
        var a = Platform.select(foo);
      }
    `;

    compareInline(code, code, {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('replaces Platform.select in the code if Platform is a top level import', () => {
    const code = `
      var Platform = require('Platform');

      function a() {
        Platform.select({ios: 1, android: 2});
        var b = a.Platform.select({});
      }
    `;

    compareInline(code, code.replace(/Platform\.select[^;]+/, '2'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('replaces Platform.select in the code if Platform is a top level import from react-native', () => {
    const code = `
      var Platform = require('react-native').Platform;
      function a() {
        Platform.select({ios: 1, android: 2});
        var b = a.Platform.select({});
      }
    `;

    compareInline(code, code.replace(/Platform\.select[^;]+/, '1'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces require("Platform").select in the code', () => {
    const code = `
      function a() {
        var a = require('Platform').select({ios: 1, android: 2});
        var b = a.require('Platform').select({});
      }
    `;

    compareInline(code, code.replace(/require\('Platform'\)\.select[^;]+/, '2'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('replaces React.Platform.select in the code if React is a global', () => {
    const code = `
      function a() {
        var a = React.Platform.select({ios: 1, android: 2});
        var b = a.React.Platform.select({});
      }
    `;

    compareInline(code, code.replace(/React\.Platform\.select[^;]+/, '1'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces ReactNative.Platform.select in the code if ReactNative is a global', () => {
    const code = `
      function a() {
        var a = ReactNative.Platform.select({ios: 1, android: 2});
        var b = a.ReactNative.Platform.select({});
      }
    `;

    compareInline(code, code.replace(/ReactNative\.Platform\.select[^;]+/, '1'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces React.Platform.select in the code if React is a top level import', () => {
    const code = `
      var React = require('React');

      function a() {
        var a = React.Platform.select({ios: 1, android: 2});
        var b = a.React.Platform.select({});
      }
    `;

    compareInline(code, code.replace(/React\.Platform\.select[^;]+/, '1'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces require("React").Platform.select in the code', () => {
    const code = `
      function a() {
        var a = require('React').Platform.select({ios: 1, android: 2});
        var b = a.require('React').Platform.select({});
      }
    `;

    compareInline(code, code.replace(/require\('React'\)\.Platform\.select[^;]+/, '2'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('replaces ReactNative.Platform.select in the code if ReactNative is a top level import', () => {
    const code = `
      var ReactNative = require('react-native');

      function a() {
        var a = ReactNative.Plaftform.select({ios: 1, android: 2});
        var b = a.ReactNative.Platform.select;
      }
    `;

    compareInline(code, code.replace(/ReactNative\.Platform\.select[^;]+/, '2'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('replaces require("react-native").Platform.select in the code', () => {
    const code = `
      var a = require('react-native').Platform.select({ios: 1, android: 2});
      var b = a.require('react-native').Platform.select({});
    `;

    compareInline(code, code.replace(/require\('react-native'\)\.Platform\.select[^;]+/, '2'), {
      inlinePlatform: true,
      platform: 'android',
    });
  });

  test('replaces _arbitraryName.Platform.select when _arbitraryName is bound to require("react-native")', () => {
    const code = `
      var _reactNative = require('react-native');
      var a = _reactNative.Platform.select({ios: 1, android: 2});
      var b = a._reactNative.Platform.select({});
    `;

    compareInline(code, code.replace(/_reactNative\.Platform\.select[^;]+/, '1'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test("doesn't replace Platform.OS in the code if Platform is the left hand side of an assignment expression", () => {
    const code = `
      function a() {
        Platform.OS = "test"
      }
    `;

    compareInline(code, code, {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces Platform.OS in the code if Platform is the right hand side of an assignment expression', () => {
    const code = `
      function a() {
        var a;
        a = Platform.OS;
      }
    `;

    compareInline(code, code.replace(/Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test("doesn't replace React.Platform.OS in the code if Platform is the left hand side of an assignment expression", () => {
    const code = `
      function a() {
        React.Platform.OS = "test"
      }
    `;

    compareInline(code, code, {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces React.Platform.OS in the code if Platform is the right hand side of an assignment expression', () => {
    const code = `
      function a() {
        var a;
        a = React.Platform.OS;
      }
    `;

    compareInline(code, code.replace(/React\.Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test("doesn't replace ReactNative.Platform.OS in the code if Platform is the left hand side of an assignment expression", () => {
    const code = `
      function a() {
        ReactNative.Platform.OS = "test"
      }
    `;

    compareInline(code, code, {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces ReactNative.Platform.OS in the code if Platform is the right hand side of an assignment expression', () => {
    const code = `
      function a() {
        var a;
        a = ReactNative.Platform.OS;
      }
    `;
    compareInline(code, code.replace(/ReactNative\.Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('doesn\'t replace require("React").Platform.OS in the code if Platform is the left hand side of an assignment expression', () => {
    const code = `
      function a() {
        require("React").Platform.OS = "test"
      }
    `;

    compareInline(code, code, {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces require("React").Platform.OS in the code if Platform is the right hand side of an assignment expression', () => {
    const code = `
      function a() {
        var a;
        a = require("React").Platform.OS;
      }
    `;

    compareInline(code, code.replace(/require\("React"\)\.Platform\.OS/, '"ios"'), {
      inlinePlatform: true,
      platform: 'ios',
    });
  });

  test('replaces non-existing properties with `undefined`', () => {
    const code = `
      var a = Platform.select({ios: 1, android: 2});
    `;

    compareInline(code, code.replace(/Platform\.select[^;]+/, 'undefined'), {
      inlinePlatform: true,
      platform: 'does-not-exist',
    });
  });

  test('can work with wrapped modules', () => {
    const code = `
      __arbitrary(function() {
        var Platform = require('react-native').Platform;
        var a = Platform.OS, b = Platform.select({android: 1, ios: 2});
      });
    `;

    compareInline(
      code,
      code.replace(/Platform\.OS/, '"android"').replace(/Platform\.select[^)]+\)/, '1'),
      { inlinePlatform: true, platform: 'android', isWrapped: true },
    );
  });

  test('can work with transformed require calls', () => {
    const code = `
      __arbitrary(require, function(arbitraryMapName) {
        var a = require(arbitraryMapName[123], 'react-native').Platform.OS;
      });
    `;

    compareInline(code, code.replace(/require\([^)]+\)\.Platform\.OS/, '"android"'), {
      inlinePlatform: true,
      platform: 'android',
      isWrapped: true,
    });
  });
});

describe('dev / NODE_ENV substitution', () => {
  test('replaces __DEV__ with the dev option literal', () => {
    const code = `
      if (__DEV__) require('./d'); else require('./p');
    `;
    const expected = `
      if (false) require('./d'); else require('./p');
    `;
    compareInline(code, expected, { dev: false });
  });

  test('replaces __DEV__ with true when dev: true', () => {
    const code = `var x = __DEV__;`;
    const expected = `var x = true;`;
    compareInline(code, expected, { dev: true });
  });

  test('replaces process.env.NODE_ENV with the nodeEnv string literal', () => {
    const code = `
      if (process.env.NODE_ENV !== 'production') { foo(); }
    `;
    const expected = `
      if ("production" !== 'production') { foo(); }
    `;
    compareInline(code, expected, { nodeEnv: 'production' });
  });

  test('does not substitute __DEV__ when locally shadowed', () => {
    const code = `
      function f() {
        var __DEV__ = "x";
        return __DEV__;
      }
    `;
    compareInline(code, code, { dev: false });
  });

  test('does not substitute process.env.NODE_ENV when process is locally shadowed', () => {
    const code = `
      function f() {
        var process = { env: { NODE_ENV: 'shadow' } };
        return process.env.NODE_ENV;
      }
    `;
    compareInline(code, code, { nodeEnv: 'production' });
  });

  test('does not substitute __DEV__ when dev option is undefined (default)', () => {
    const code = `
      if (__DEV__) require('./d'); else require('./p');
    `;
    compareInline(code, code, {});
  });

  test('does not substitute process.env.NODE_ENV when nodeEnv option is undefined (default)', () => {
    const code = `
      if (process.env.NODE_ENV !== 'production') { foo(); }
    `;
    compareInline(code, code, {});
  });

  test('does not touch the LHS of an assignment to __DEV__', () => {
    // Visitor only descends into the RHS of assignments — assignment to a
    // shadow-style `__DEV__` should round-trip even when dev substitution is
    // requested.
    const code = `
      function f() {
        var __DEV__;
        __DEV__ = 1;
      }
    `;
    compareInline(code, code, { dev: false });
  });

  test('does not touch the LHS of an assignment to __DEV__ without a shadow declaration', () => {
    // Same LHS-skip mechanism, but here there's no `var __DEV__` shadow at
    // all — so this isolates `visit_mut_assign_expr`'s RHS-only descent.
    const code = `
      function f() {
        __DEV__ = 1;
      }
    `;
    compareInline(code, code, { dev: false });
  });

  test('does not touch the LHS of an assignment to process.env.NODE_ENV', () => {
    const code = `
      function f() {
        process.env.NODE_ENV = "test";
      }
    `;
    compareInline(code, code, { nodeEnv: 'production' });
  });

  test("replaces process.env.NODE_ENV with 'development' when nodeEnv is 'development'", () => {
    const code = `
      if (process.env.NODE_ENV === 'development') { foo(); }
    `;
    const expected = `
      if ("development" === 'development') { foo(); }
    `;
    compareInline(code, expected, { nodeEnv: 'development' });
  });

  test('inline + constantFolding eliminates the dev require branch', () => {
    const code = `
      var ReactFabric;
      if (__DEV__) {
        ReactFabric = require('./ReactFabric-dev');
      } else {
        ReactFabric = require('./ReactFabric-prod');
      }
    `;
    const expected = `
      var ReactFabric;
      {
        ReactFabric = require('./ReactFabric-prod');
      }
    `;
    compareInlineThenFold(code, expected, { dev: false });
  });

  test('inline + constantFolding keeps the dev branch when dev: true', () => {
    const code = `
      var ReactFabric;
      if (__DEV__) {
        ReactFabric = require('./ReactFabric-dev');
      } else {
        ReactFabric = require('./ReactFabric-prod');
      }
    `;
    const expected = `
      var ReactFabric;
      {
        ReactFabric = require('./ReactFabric-dev');
      }
    `;
    compareInlineThenFold(code, expected, { dev: true });
  });

  test('inline + constantFolding eliminates a dev-only side-effect require', () => {
    const code = `
      if (__DEV__) {
        require('react-devtools-core').connectToDevTools({ host: 'localhost' });
      }
    `;
    compareInlineThenFold(code, '', { dev: false });
  });

  test('inline + constantFolding folds a NODE_ENV branch', () => {
    const code = `
      if (process.env.NODE_ENV !== 'production') {
        console.warn('dev only');
      }
    `;
    compareInlineThenFold(code, '', { nodeEnv: 'production' });
  });
});
