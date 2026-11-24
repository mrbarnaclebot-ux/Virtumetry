import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useRenameWorld } from '@/lib/api';

type Props = { id: string; title: string; onClose: () => void };

/** Rename modal per UI-SPEC §4. Mount it with key={id}; unmounting closes it. */
export function RenameModal({ id, title, onClose }: Props) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const rename = useRenameWorld();
  const [value, setValue] = useState(title);
  const [focused, setFocused] = useState(false);
  const [emptyError, setEmptyError] = useState(false);
  const trimmed = value.trim();
  const saving = rename.isPending;
  const disabled = !trimmed || trimmed === title || saving;

  const save = () => {
    if (!trimmed) return setEmptyError(true);
    if (disabled) return;
    rename.mutate({ id, title: trimmed }, { onSuccess: onClose });
  };
  const cancel = () => {
    if (!saving) onClose();
  };

  let helper = <ThemedText type="small" themeColor="textSecondary" style={styles.counter}>{`${value.length}/80`}</ThemedText>;
  if (rename.isError) {
    helper = (
      <ThemedText type="small" themeColor="destructive">
        {"Couldn't rename. Check your connection and try again."}
      </ThemedText>
    );
  } else if (emptyError) {
    helper = (
      <ThemedText type="small" themeColor="destructive">
        {"Name can't be empty."}
      </ThemedText>
    );
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={cancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
        <Pressable accessible={false} onPress={cancel} style={[StyleSheet.absoluteFill, styles.backdrop]} />
        <View
          accessibilityViewIsModal
          style={[styles.card, { width: Math.min(width - 48, 400), backgroundColor: theme.background }]}>
          <ThemedText type="subtitle" accessibilityRole="header">
            Rename scan
          </ThemedText>
          <TextInput
            value={value}
            onChangeText={(t) => {
              setValue(t);
              setEmptyError(false);
              rename.reset();
            }}
            onSubmitEditing={save}
            editable={!saving}
            autoFocus
            selectTextOnFocus
            maxLength={80}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            autoCapitalize="sentences"
            placeholder="Scan name"
            accessibilityLabel="Scan name"
            placeholderTextColor={theme.textSecondary}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={[
              styles.input,
              { backgroundColor: theme.backgroundElement, color: theme.text },
              focused && { borderColor: theme.accent },
            ]}
          />
          <View style={styles.helper}>{helper}</View>
          <View style={styles.buttons}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={cancel}
              style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
              <ThemedText>Cancel</ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save Name"
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={save}
              style={({ pressed }) => [
                styles.button,
                disabled && !saving && styles.disabled,
                pressed && styles.pressed,
              ]}>
              {saving ? (
                <ActivityIndicator size="small" color={theme.accent} />
              ) : (
                <ThemedText type="smallBold" themeColor="accent">
                  Save Name
                </ThemedText>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.4)' },
  card: { borderRadius: 16, padding: Spacing.four },
  input: {
    marginTop: Spacing.three,
    height: 48,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  helper: { marginTop: Spacing.two },
  counter: { textAlign: 'right' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.three, marginTop: Spacing.four },
  button: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
