// Realistic worklet-heavy screen used for bench fixtures.
// Mixes auto-workletization (animated style/derived value/reaction/scroll
// handler/frame callback), explicit `'worklet'` directives, gesture handlers,
// inline styles, free-variable closures, and class methods so the fixture
// exercises every code path the plugin walks.
import { Animated, StyleSheet, View, Text } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  useAnimatedStyle,
  useDerivedValue,
  useAnimatedReaction,
  useFrameCallback,
  useAnimatedScrollHandler,
  useSharedValue,
  withTiming,
  withSpring,
  runOnUI,
  runOnJS,
  Easing,
} from 'react-native-reanimated';

const SPRING_CONFIG = { mass: 0.5, stiffness: 240, damping: 18 };
const TIMING_CONFIG = { duration: 220, easing: Easing.out(Easing.cubic) };

function clamp(v, lo, hi) {
  'worklet';
  return v < lo ? lo : v > hi ? hi : v;
}

function describeOffset(x, y) {
  'worklet';
  return '(' + x + ', ' + y + ')';
}

export default function Card({ initialX, initialY, onTap }) {
  const x = useSharedValue(initialX);
  const y = useSharedValue(initialY);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const rotation = useSharedValue(0);
  const lastTapTs = useSharedValue(0);

  const transform = useDerivedValue(() => {
    return [
      { translateX: x.value },
      { translateY: y.value },
      { rotate: rotation.value + 'deg' },
      { scale: scale.value },
    ];
  });

  useAnimatedReaction(
    () => x.value > 100,
    (over, prev) => {
      if (over && !prev) {
        opacity.value = withTiming(0.6, TIMING_CONFIG);
      } else if (!over && prev) {
        opacity.value = withTiming(1, TIMING_CONFIG);
      }
    },
  );

  const frame = useFrameCallback((info) => {
    const dt = info.timeSincePreviousFrame ?? 0;
    if (dt > 0) {
      rotation.value = (rotation.value + dt * 0.05) % 360;
    }
  }, true);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll(event) {
      x.value = clamp(x.value - event.contentOffset.x * 0.1, -200, 200);
    },
    onBeginDrag() {
      scale.value = withSpring(0.95, SPRING_CONFIG);
    },
    onEndDrag() {
      scale.value = withSpring(1, SPRING_CONFIG);
    },
  });

  const pan = Gesture.Pan()
    .onBegin((event) => {
      'worklet';
      lastTapTs.value = event.absoluteX;
    })
    .onUpdate((event) => {
      x.value = clamp(initialX + event.translationX, -200, 200);
      y.value = clamp(initialY + event.translationY, -400, 400);
    })
    .onEnd(() => {
      x.value = withSpring(initialX, SPRING_CONFIG);
      y.value = withSpring(initialY, SPRING_CONFIG);
    });

  const tap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      runOnJS(onTap)('double');
    });

  const longPress = Gesture.LongPress().onEnd(() => {
    runOnUI(() => {
      rotation.value = withTiming(rotation.value + 90, TIMING_CONFIG);
    })();
  });

  const animated = useAnimatedStyle(() => {
    return {
      opacity: opacity.value,
      transform: transform.value,
      backgroundColor: x.value > 0 ? '#34d399' : '#fbbf24',
    };
  });

  return (
    <GestureDetector gesture={Gesture.Race(pan, tap, longPress)}>
      <Animated.View style={[styles.card, animated]}>
        <Animated.Text
          style={{
            opacity: opacity.value,
            transform: [{ translateY: y.value * 0.1 }],
          }}
        >
          {describeOffset(x.value, y.value)}
        </Animated.Text>
        <Animated.ScrollView onScroll={scrollHandler} scrollEventThrottle={16}>
          <View style={styles.row}>
            <Text>Frame: {frame.id}</Text>
          </View>
        </Animated.ScrollView>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  card: { width: 240, height: 320, borderRadius: 16 },
  row: { flexDirection: 'row', padding: 8 },
});
