/**
 * Tests for the codegen file gate.
 *
 * The gate decides whether a source file gets handed to `@react-native/codegen`
 * to be replaced with a generated view-config module. Getting it wrong means
 * either:
 *   - missing a real `*NativeComponent` file (component renders without its
 *     view config and crashes at native bridge time), or
 *   - matching the helper file `codegenNativeComponent.js` itself, replacing
 *     the function with a config object so every consumer crashes with
 *     `codegenNativeComponent is not a function` (RN core hits this on
 *     Android paths that go through the helper at runtime).
 */
import { isCodegenFile } from '../src/codegen';

describe('isCodegenFile', () => {
  test('matches conventional `<LibraryName>NativeComponent.{js,ts,tsx}` files with the helper call', () => {
    const src = `
      import codegenNativeComponent from '../../codegenNativeComponent';
      export default (codegenNativeComponent<Props>('Foo'): NativeType);
    `;
    expect(isCodegenFile('FooNativeComponent.js', src)).toBe(true);
    expect(isCodegenFile('FooNativeComponent.ts', src)).toBe(true);
    expect(isCodegenFile('FooNativeComponent.tsx', src)).toBe(true);
    expect(isCodegenFile('/abs/path/AndroidScrollViewNativeComponent.js', src)).toBe(true);
  });

  test('matches third-party files that do not follow the `*NativeComponent` naming', () => {
    // `react-native-safe-area-context` ships its codegen spec at
    // `src/specs/NativeSafeAreaProvider.ts` (not `*NativeComponent.ts`).
    // Upstream `@react-native/babel-plugin-codegen` doesn't gate by filename
    // at all — it gates on the AST shape — so this file MUST match for the
    // build-time replacement to run. Otherwise the runtime fallback fires
    // and prints `Codegen didn't run for RNCSafeAreaProvider…`.
    const src = `
      import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';
      export default codegenNativeComponent<NativeProps>('RNCSafeAreaProvider');
    `;
    expect(isCodegenFile('NativeSafeAreaProvider.ts', src)).toBe(true);
    expect(
      isCodegenFile(
        '/abs/node_modules/react-native-safe-area-context/src/specs/NativeSafeAreaProvider.ts',
        src,
      ),
    ).toBe(true);
  });

  test('skips files that do not call the helper', () => {
    expect(isCodegenFile('FooNativeComponent.js', 'export const x = 1;')).toBe(false);
    expect(isCodegenFile('SomethingElse.js', 'export const x = 1;')).toBe(false);
  });

  test('does NOT match the helper file `codegenNativeComponent.{js,ts,tsx}` itself', () => {
    // The helper's body declares `function codegenNativeComponent<Props>(…)`
    // — the `<` triggers the substring gate. Without an explicit basename
    // exclusion the helper would be replaced with a generated view-config
    // object, breaking every consumer that imports + calls it. RN core's
    // Android component-loading paths go through this helper at runtime;
    // iOS Bridgeless Fabric routes around it, which is why this regression
    // hit Android before iOS.
    const helperSrc = `
      function codegenNativeComponent<Props: {...}>(name) {
        return requireNativeComponent(name);
      }
      export default codegenNativeComponent;
    `;
    expect(isCodegenFile('codegenNativeComponent.js', helperSrc)).toBe(false);
    expect(isCodegenFile('codegenNativeComponent.ts', helperSrc)).toBe(false);
    expect(isCodegenFile('codegenNativeComponent.tsx', helperSrc)).toBe(false);
    expect(
      isCodegenFile('/abs/react-native/Libraries/Utilities/codegenNativeComponent.js', helperSrc),
    ).toBe(false);
  });
});
