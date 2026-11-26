import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, focusRing } from '@/components/ui/button';
import { Surface } from '@/components/ui/surface';
import { TextField } from '@/components/ui/text-field';
import { color, minTarget, radius, space } from '@/design/tokens';
import { useRenameWorld } from '@/lib/api';

type Props = { id: string; title: string; onClose: () => void };

/** Rename dialog (06.1 UI-SPEC §5): level-2 surface over scrim.modal. Mount it with key={id}; unmounting closes it. */
export function RenameModal({ id, title, onClose }: Props) {
  const { width } = useWindowDimensions();
  const rename = useRenameWorld();
  const [value, setValue] = useState(title);
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

  const error = rename.isError
    ? "Couldn't rename. Check your connection and try again."
    : emptyError
      ? "Name can't be empty."
      : null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={cancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
        <Pressable accessible={false} onPress={cancel} style={[StyleSheet.absoluteFill, styles.backdrop]} />
        <Surface level={2} accessibilityViewIsModal style={[styles.card, { width: Math.min(width - 48, 400) }]}>
          <ThemedText type="heading" accessibilityRole="header">
            Rename scan
          </ThemedText>
          <TextField
            label="Scan name"
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
            error={error}
            helper={`${value.length}/80`}
          />
          <View style={styles.buttons}>
            <Button variant="ghost" size="md" label="Cancel" onPress={cancel} />
            {/* Ghost button with the label in primary (§5); Button has no primary-ink ghost. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save Name"
              accessibilityState={{ disabled, busy: saving }}
              disabled={disabled}
              onPress={save}
              style={(s) => [styles.save, s.pressed && styles.pressed, focusRing(s)]}>
              {saving ? (
                <ActivityIndicator size="small" color={color.primary} />
              ) : (
                <ThemedText type="bodyStrong" tone={disabled ? 'faint' : 'primary'}>
                  Save Name
                </ThemedText>
              )}
            </Pressable>
          </View>
        </Surface>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  backdrop: { backgroundColor: color.scrim.modal },
  card: { padding: space.xl, gap: space.lg },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.sm },
  save: {
    minWidth: minTarget,
    height: minTarget,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { backgroundColor: color.surface.pressed },
});
