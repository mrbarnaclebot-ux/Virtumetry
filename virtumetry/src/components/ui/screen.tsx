import { Fragment, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { color, layout } from '@/design/tokens';

type Props = {
  children: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  maxWidth?: 'content' | 'form';
  refresh?: { refreshing: boolean; onRefresh: () => void };
  keyboard?: boolean;
  /** Extra style for the centred content column. */
  contentStyle?: StyleProp<ViewStyle>;
};

/** Canvas + safe area + optional scroll/refresh/keyboard, content in a centred gutter column (UI-SPEC §5). */
export function Screen({ children, scroll, edges, maxWidth = 'content', refresh, keyboard, contentStyle }: Props) {
  const column = [styles.column, { maxWidth: maxWidth === 'form' ? layout.maxForm : layout.maxContent }, contentStyle];
  const Keyboard = keyboard ? KeyboardAvoidingView : Fragment;
  const keyboardProps = keyboard ? { style: styles.flex, behavior: Platform.OS === 'ios' ? ('padding' as const) : undefined } : {};
  return (
    <View style={styles.canvas}>
      <SafeAreaView style={styles.flex} edges={edges}>
        <Keyboard {...keyboardProps}>
          {scroll || refresh ? (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={column}
              refreshControl={
                refresh && (
                  <RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} tintColor={color.primary} colors={[color.primary]} />
                )
              }>
              {children}
            </ScrollView>
          ) : (
            <View style={[styles.flex, column]}>{children}</View>
          )}
        </Keyboard>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },
  column: { width: '100%', alignSelf: 'center', paddingHorizontal: layout.gutter },
});
