import { useId, useState, type ComponentRef, type Ref } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Glyph } from '@/components/ui/glyph';
import { color, radius, space, type as typeScale } from '@/design/tokens';

type Props = TextInputProps & {
  label: string;
  error?: string | null;
  helper?: string;
  /** Inside a raised group: fill with the canvas colour instead of raised. */
  inGroup?: boolean;
  ref?: Ref<ComponentRef<typeof TextInput>>;
};

/** Labelled input (UI-SPEC §5). Forwards every TextInput prop unchanged (secureTextEntry, autoComplete…). */
export function TextField({ label, error, helper, inGroup, style, onFocus, onBlur, ref, ...input }: Props) {
  const [focused, setFocused] = useState(false);
  const messageId = useId();
  const message = error || helper;
  const border = error || focused ? 2 : 1;
  const { maxScale, ...bodyStyle } = typeScale.body;

  return (
    <View style={styles.field}>
      <ThemedText type="label">{label}</ThemedText>
      <TextInput
        {...input}
        ref={ref}
        accessibilityLabel={label}
        aria-describedby={Platform.OS === 'web' && message ? messageId : undefined}
        maxFontSizeMultiplier={input.maxFontSizeMultiplier ?? maxScale}
        placeholderTextColor={color.textMuted}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={[
          styles.input,
          bodyStyle,
          {
            backgroundColor: inGroup ? color.bg : color.surface.raised,
            borderWidth: border,
            borderColor: error ? color.danger : focused ? color.primary : color.border,
            // Keep the text still when the border thickens.
            paddingHorizontal: space.lg - (border - 1),
          },
          style,
        ]}
      />
      {error ? (
        <View nativeID={messageId} style={styles.error} accessibilityLiveRegion="polite">
          <Glyph id="alert" size={16} color={color.danger} />
          <ThemedText type="label" tone="danger" style={styles.flex}>
            {error}
          </ThemedText>
        </View>
      ) : (
        helper && (
          <ThemedText nativeID={messageId} type="caption" tone="muted">
            {helper}
          </ThemedText>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.sm },
  input: { height: 52, borderRadius: radius.md, color: color.text },
  error: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  flex: { flex: 1 },
});
