import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { toDisplayState, type DisplayState, type LibraryItem, type LocalScan } from '@/library/display-state';

export type RowItem = LibraryItem | (LocalScan & { local: true });

const TONE = { muted: 'textSecondary', accent: 'accent', destructive: 'destructive' } as const;
const SECONDARY_TONE = { muted: 'textSecondary', warning: 'warning' } as const;

type Props = {
  item: RowItem;
  onMore: (item: RowItem, state: DisplayState) => void;
  /** Local rows only: opens capture/[id] at review or upload (UI-SPEC §2). */
  onOpen?: (item: LocalScan & { local: true }) => void;
};

export function LibraryRow({ item, onMore, onOpen }: Props) {
  const theme = useTheme();
  const state = toDisplayState(item, new Date());
  const thumbnailUrl = 'local' in item ? undefined : item.assets?.thumbnail_url;
  const [imageFailed, setImageFailed] = useState(false);
  const label = [state.displayTitle, state.statusLine, state.secondaryLine].filter(Boolean).join(', ');

  return (
    <View style={[styles.row, { opacity: state.rowOpacity }]}>
      <Pressable
        accessible
        accessibilityLabel={label}
        {...('local' in item
          ? {
              accessibilityRole: 'button' as const,
              accessibilityHint: item.uploadState === 'saved' ? 'Opens review' : 'Shows upload',
              onPress: () => onOpen?.(item),
            }
          : { disabled: true })}
        style={({ pressed }) => [styles.main, pressed && { backgroundColor: theme.backgroundSelected }]}>
        <View accessible={false} style={[styles.thumb, { backgroundColor: theme.backgroundElement }]}>
          {thumbnailUrl && !imageFailed ? (
            <Image
              source={{ uri: thumbnailUrl }}
              style={styles.thumb}
              contentFit="cover"
              transition={150}
              onError={() => setImageFailed(true)}
            />
          ) : (
            <SymbolView name="cube.transparent" size={24} tintColor={theme.textSecondary} />
          )}
        </View>
        <View style={styles.text}>
          <ThemedText type="smallBold" numberOfLines={2} maxFontSizeMultiplier={1.6}>
            {state.displayTitle}
          </ThemedText>
          <View style={styles.status}>
            {state.icon && (
              <SymbolView name={state.icon} size={14} tintColor={theme[TONE[state.tone]]} />
            )}
            <ThemedText
              type="small"
              themeColor={TONE[state.tone]}
              maxFontSizeMultiplier={1.6}
              style={styles.tabular}>
              {state.statusLine}
            </ThemedText>
          </View>
          {state.progress != null && (
            <View
              testID="row-progress"
              accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: 100, now: state.progress }}
              style={[styles.track, { backgroundColor: theme.backgroundElement }]}>
              <View
                style={[
                  styles.fill,
                  { width: `${Math.min(100, Math.max(0, state.progress))}%`, backgroundColor: theme.accent },
                ]}
              />
            </View>
          )}
          {state.secondaryLine && (
            <ThemedText
              type="small"
              themeColor={SECONDARY_TONE[state.secondaryTone]}
              maxFontSizeMultiplier={1.6}
              style={styles.secondary}>
              {state.secondaryLine}
            </ThemedText>
          )}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`More actions for ${state.displayTitle}`}
        accessibilityHint="Rename or delete"
        onPress={() => onMore(item, state)}
        style={({ pressed }) => [styles.more, pressed && { backgroundColor: theme.backgroundSelected }]}>
        <SymbolView name="ellipsis" size={20} tintColor={theme.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 96, paddingVertical: Spacing.three },
  main: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.three },
  thumb: { width: 64, height: 64, borderRadius: 8, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  text: { flex: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one, marginTop: Spacing.two },
  tabular: { fontVariant: ['tabular-nums'], flexShrink: 1 },
  track: { height: 4, borderRadius: 2, marginTop: Spacing.one, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  secondary: { marginTop: Spacing.one },
  more: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
