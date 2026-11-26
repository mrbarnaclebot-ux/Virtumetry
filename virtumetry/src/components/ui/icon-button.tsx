import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { focusRing, usePressScale } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { color, minTarget, radius } from '@/design/tokens';

type Props = {
  icon: IconName;
  /** Required: icon-only controls always carry a name. */
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  variant?: 'plain' | 'scrim';
  /** Icon colour token (default textMuted on plain, text on scrim). */
  tone?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** 44x44 icon-only button (UI-SPEC §5). */
export function IconButton({ icon, accessibilityLabel, accessibilityHint, onPress, variant = 'plain', tone, disabled = false, style, testID }: Props) {
  const press = usePressScale();
  const scrim = variant === 'scrim';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      onPress={onPress}
      style={(s) => [styles.wrap, style, focusRing(s)]}>
      {({ pressed }) => (
        <Animated.View
          style={[
            styles.body,
            { backgroundColor: pressed ? (scrim ? color.secondary : color.surface.pressed) : scrim ? color.scrim.hud : 'transparent' },
            press.style,
          ]}>
          <Icon name={icon} color={disabled ? color.textFaint : (tone ?? (scrim ? color.text : color.textMuted))} />
        </Animated.View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { width: minTarget, height: minTarget, borderRadius: radius.pill },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
});
