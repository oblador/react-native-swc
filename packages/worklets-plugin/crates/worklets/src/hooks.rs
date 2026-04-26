//! Static metadata for React Native Reanimated hooks, gesture objects, and
//! layout animations. Kept separate from `plugin.rs` so the big tables
//! don't dwarf the transformation logic.
//!
//! All tables are `pub(crate)`. Updating Reanimated's public API (e.g.
//! adding a new animation primitive) means editing this file and nothing
//! else.

/// Hooks whose argument positions (0-indexed) hold worklet callbacks that
/// need to be transformed. `(hookName, argPositions)`.
pub(crate) fn function_hooks() -> &'static [(&'static str, &'static [usize])] {
    &[
        ("useFrameCallback", &[0]),
        ("useAnimatedStyle", &[0]),
        ("useAnimatedProps", &[0]),
        ("createAnimatedPropAdapter", &[0]),
        ("useDerivedValue", &[0]),
        ("useAnimatedScrollHandler", &[0]),
        ("useAnimatedReaction", &[0, 1]),
        ("withTiming", &[2]),
        ("withSpring", &[2]),
        ("withDecay", &[1]),
        ("withRepeat", &[3]),
        ("runOnUI", &[0]),
        ("executeOnUIRuntimeSync", &[0]),
        ("scheduleOnUI", &[0]),
        ("runOnUISync", &[0]),
        ("runOnUIAsync", &[0]),
        ("runOnRuntime", &[1]),
        ("runOnRuntimeSync", &[1]),
        ("runOnRuntimeAsync", &[1]),
        ("scheduleOnRuntime", &[1]),
        ("runOnRuntimeSyncWithId", &[1]),
        ("scheduleOnRuntimeWithId", &[1]),
        ("useTapGesture", &[0]),
        ("usePanGesture", &[0]),
        ("usePinchGesture", &[0]),
        ("useRotationGesture", &[0]),
        ("useFlingGesture", &[0]),
        ("useLongPressGesture", &[0]),
        ("useNativeGesture", &[0]),
        ("useManualGesture", &[0]),
        ("useHoverGesture", &[0]),
    ]
}

/// Hooks whose worklet argument is a plain object literal of handlers
/// (each value is itself a worklet), rather than a direct callback.
pub(crate) fn is_object_hook(name: &str) -> bool {
    matches!(
        name,
        "useAnimatedScrollHandler"
            | "useTapGesture"
            | "usePanGesture"
            | "usePinchGesture"
            | "useRotationGesture"
            | "useFlingGesture"
            | "useLongPressGesture"
            | "useNativeGesture"
            | "useManualGesture"
            | "useHoverGesture"
    )
}

/// `Gesture.X()` builder methods whose callbacks must be workletised.
pub(crate) const GESTURE_BUILDER_METHODS: &[&str] = &[
    "onBegin",
    "onStart",
    "onEnd",
    "onFinalize",
    "onUpdate",
    "onChange",
    "onTouchesDown",
    "onTouchesMove",
    "onTouchesUp",
    "onTouchesCancelled",
];

/// Identifiers reachable as `Gesture.X()` that build a gesture instance.
pub(crate) const GESTURE_OBJECTS: &[&str] = &[
    "Tap",
    "Pan",
    "Pinch",
    "Rotation",
    "Fling",
    "LongPress",
    "ForceTouch",
    "Native",
    "Manual",
    "Race",
    "Simultaneous",
    "Exclusive",
    "Hover",
];

/// Layout-animation chain method names that take a worklet callback.
pub(crate) const LAYOUT_ANIM_CALLBACKS: &[&str] = &["withCallback"];

/// Known Reanimated layout-animation / transition primitives.
pub(crate) const LAYOUT_ANIMATIONS: &[&str] = &[
    "BounceIn",
    "BounceInDown",
    "BounceInLeft",
    "BounceInRight",
    "BounceInUp",
    "BounceOut",
    "BounceOutDown",
    "BounceOutLeft",
    "BounceOutRight",
    "BounceOutUp",
    "FadeIn",
    "FadeInDown",
    "FadeInLeft",
    "FadeInRight",
    "FadeInUp",
    "FadeOut",
    "FadeOutDown",
    "FadeOutLeft",
    "FadeOutRight",
    "FadeOutUp",
    "FlipInEasyX",
    "FlipInEasyY",
    "FlipInXDown",
    "FlipInXUp",
    "FlipInYLeft",
    "FlipInYRight",
    "FlipOutEasyX",
    "FlipOutEasyY",
    "FlipOutXDown",
    "FlipOutXUp",
    "FlipOutYLeft",
    "FlipOutYRight",
    "LightSpeedInLeft",
    "LightSpeedInRight",
    "LightSpeedOutLeft",
    "LightSpeedOutRight",
    "PinwheelIn",
    "PinwheelOut",
    "RollInLeft",
    "RollInRight",
    "RollOutLeft",
    "RollOutRight",
    "RotateInDownLeft",
    "RotateInDownRight",
    "RotateInUpLeft",
    "RotateInUpRight",
    "RotateOutDownLeft",
    "RotateOutDownRight",
    "RotateOutUpLeft",
    "RotateOutUpRight",
    "SlideInDown",
    "SlideInLeft",
    "SlideInRight",
    "SlideInUp",
    "SlideOutDown",
    "SlideOutLeft",
    "SlideOutRight",
    "SlideOutUp",
    "StretchInX",
    "StretchInY",
    "StretchOutX",
    "StretchOutY",
    "ZoomIn",
    "ZoomInDown",
    "ZoomInEasyDown",
    "ZoomInEasyUp",
    "ZoomInLeft",
    "ZoomInRight",
    "ZoomInRotate",
    "ZoomInUp",
    "ZoomOut",
    "ZoomOutDown",
    "ZoomOutEasyDown",
    "ZoomOutEasyUp",
    "ZoomOutLeft",
    "ZoomOutRight",
    "ZoomOutRotate",
    "ZoomOutUp",
    "Layout",
    "LinearTransition",
    "SequencedTransition",
    "FadingTransition",
    "JumpingTransition",
    "CurvedTransition",
    "EntryExitTransition",
];

/// Methods callable on a layout-animation chain.
pub(crate) const LAYOUT_ANIM_CHAINABLE: &[&str] = &[
    "build",
    "duration",
    "delay",
    "getDuration",
    "randomDelay",
    "getDelay",
    "getDelayFunction",
    "easing",
    "rotate",
    "springify",
    "damping",
    "mass",
    "stiffness",
    "overshootClamping",
    "energyThreshold",
    "restDisplacementThreshold",
    "restSpeedThreshold",
    "withInitialValues",
    "getAnimationAndConfig",
    "easingX",
    "easingY",
    "easingWidth",
    "easingHeight",
    "entering",
    "exiting",
    "reverse",
];
