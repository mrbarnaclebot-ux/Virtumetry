import { SymbolView } from 'expo-symbols';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

// Header + empty state only; the real scan list replaces the body in 03-06.
export default function LibraryScreen() {
  const theme = useTheme();
  return (
    <ThemedView style={styles.flex}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <ThemedText type="title" accessibilityRole="header" style={styles.title}>
          Library
        </ThemedText>
        <View style={styles.empty}>
          <View accessible={false}>
            <SymbolView name="cube.transparent" size={48} tintColor={theme.textSecondary} />
          </View>
          <ThemedText type="subtitle" style={styles.emptyHeading}>
            No scans yet
          </ThemedText>
          <ThemedText themeColor="textSecondary" style={styles.center}>
            Scans you capture show up here, with their progress and status. Pull down to refresh.
          </ThemedText>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.three,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  title: { marginTop: Spacing.three, marginBottom: Spacing.four },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: Spacing.six },
  emptyHeading: { marginTop: Spacing.three, marginBottom: Spacing.two },
  center: { textAlign: 'center' },
});
