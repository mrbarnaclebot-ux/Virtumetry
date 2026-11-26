import { ActivityIndicator, Platform, Pressable, StyleSheet, type PressableStateCallbackType, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { haptic as haptics } from '@/design/haptics';
import { ease, useReduceMotion } from '@/design/motion';
import { color, motion, radius, space } from '@/design/tokens';

/** UI-SPEC §11 press feel: scale 0.97 over 120 ms outQuart; Reduce Motion keeps the fill change only. */
export function usePressScale() {
  const reduce = useReduceMotion();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const to = (v: number) => {
    if (!reduce) scale.set(withTiming(v, { duration: motion.duration.press, easing: ease.outQuart }));
  };
  return { style, onPressIn: () => to(motion.pressScale), onPressOut: () => to(1) };
}

/** Web focus ring (2 px primary, offset 2). RN-web passes `focused` to the Pressable style callback. */
export const focusRing = (s: PressableStateCallbackType) =>
  Platform.OS === 'web' && (s as { focused?: boolean }).focused ? styles.focus : null;

const VARIANTS = {
  primary: { fill: color.primary, pressed: color.primaryPressed, tone: 'onPrimary', ink: color.onPrimary },
  secondary: { fill: color.secondary, pressed: color.secondaryPressed, tone: 'onSecondary', ink: color.onSecondary },
  ghost: { fill: 'transparent', pressed: color.surface.pressed, tone: 'text', ink: color.text },
  destructive: { fill: 'transparent', pressed: color.surface.pressed, tone: 'danger', ink: color.danger },
} as const;

type Props = {
  label: string;
  onPress: () => void;
  variant?: keyof typeof VARIANTS;
  size?: 'lg' | 'md';
  icon?: IconName;
  busy?: boolean;
  /** Visible text while busy; the accessible name stays `label`. */
  busyLabel?: string;
  disabled?: boolean;
  /** Read by screen readers when disabled: why it can't be pressed. */
  hint?: string;
  /** Light impact on press; default true for primary only. */
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  icon,
  busy = false,
  busyLabel,
  disabled = false,
  hint,
  haptic = variant === 'primary',
  style,
  testID,
}: Props) {
  const press = usePressScale();
  const v = VARIANTS[variant];
  // Disabled filled buttons go flat grey (no opacity trick); text buttons just fade their label.
  const flat = disabled && (variant === 'primary' || variant === 'secondary');
  const tone = disabled ? 'faint' : v.tone;
  const ink = disabled ? color.textFaint : v.ink;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={disabled ? hint : undefined}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      onPress={() => {
        if (haptic) haptics.light();
        onPress();
      }}
      style={(s) => [styles.wrap, style, focusRing(s)]}>
      {({ pressed }) => (
        <Animated.View
          style={[
            styles.body,
            { height: size === 'lg' ? 52 : 44, backgroundColor: flat ? color.surface.pressed : pressed ? v.pressed : v.fill },
            press.style,
          ]}>
          {busy ? (
            <ActivityIndicator testID="button-busy" size="small" color={ink} />
          ) : (
            icon && <Icon name={icon} color={ink} />
          )}
          <ThemedText type="bodyStrong" tone={tone} numberOfLines={1}>
            {busy && busyLabel ? busyLabel : label}
          </ThemedText>
        </Animated.View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.md },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
  },
  focus: { outlineColor: color.primary, outlineStyle: 'solid', outlineWidth: 2, outlineOffset: 2 },
});
