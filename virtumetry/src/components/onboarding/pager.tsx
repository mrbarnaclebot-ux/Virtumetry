import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, type ScrollViewInstance, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { OnboardingArt } from '@/components/onboarding/art';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { haptic } from '@/design/haptics';
import { ease, useReduceMotion } from '@/design/motion';
import { color, layout, motion, radius, space } from '@/design/tokens';

export type OnboardingPage = { headline: string; body: string };

type Props = {
  pages: OnboardingPage[];
  /** Last-page button label. */
  ctaLabel: string;
  onFinish: () => void;
  onSkip: () => void;
  /** Replay from Settings: the top button reads "Close". */
  replay?: boolean;
};

/** UI-SPEC §8.1: horizontal paging ScrollView, fixed top row, dots and primary button. */
export function OnboardingPager({ pages, ctaLabel, onFinish, onSkip, replay }: Props) {
  const window = useWindowDimensions();
  const reduce = useReduceMotion();
  const scroller = useRef<ScrollViewInstance>(null);
  const [pageW, setPageW] = useState(Math.min(window.width, layout.maxContent));
  const [index, setIndex] = useState(0);
  const last = index === pages.length - 1;

  const artW = pageW - layout.gutter * 2;
  const artH = Math.min(artW * 0.85, window.height * 0.46);

  const settle = (i: number) => {
    if (i === index) return;
    setIndex(i);
    haptic.selection();
    AccessibilityInfo.announceForAccessibility(`Page ${i + 1} of ${pages.length}`);
  };

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    settle(Math.round(e.nativeEvent.contentOffset.x / pageW));

  const next = () => {
    scroller.current?.scrollTo({ x: (index + 1) * pageW, animated: !reduce });
    settle(index + 1);
  };

  return (
    <Screen contentStyle={styles.column}>
      <View style={styles.top}>
        <ThemedText type="eyebrow" tone="muted">{`${index + 1} of ${pages.length}`}</ThemedText>
        <Button variant="ghost" size="md" label={replay ? 'Close' : 'Skip'} onPress={onSkip} />
      </View>
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onLayout={(e) => setPageW(e.nativeEvent.layout.width)}
        onMomentumScrollEnd={onMomentumScrollEnd}
        style={styles.flex}>
        {pages.map((p, i) => (
          <View key={p.headline} accessible accessibilityLabel={`${p.headline}. ${p.body}`} style={[styles.page, { width: pageW }]}>
            <ArtEnter active={i === index} reduce={reduce}>
              <OnboardingArt page={i as 0 | 1 | 2 | 3} width={artW} height={artH} />
            </ArtEnter>
            <ThemedText type="display" style={styles.headline}>
              {p.headline}
            </ThemedText>
            <ThemedText type="body" tone="muted" style={styles.body}>
              {p.body}
            </ThemedText>
          </View>
        ))}
      </ScrollView>
      <View style={styles.dots}>
        {pages.map((p, i) => (
          <Dot key={p.headline} active={i === index} reduce={reduce} />
        ))}
      </View>
      <View style={styles.action}>
        <Button size="lg" label={last ? ctaLabel : 'Next'} onPress={last ? onFinish : next} />
      </View>
    </Screen>
  );
}

const timing = { duration: motion.duration.slow, easing: ease.outQuart };

/** Art enters with opacity 0→1 + translateX 16→0 (250 ms outQuart); instant under Reduce Motion. */
function ArtEnter({ active, reduce, children }: { active: boolean; reduce: boolean; children: ReactNode }) {
  const t = useSharedValue(1);
  useEffect(() => {
    if (!active || reduce) {
      t.set(1);
      return;
    }
    t.set(0);
    t.set(withTiming(1, timing));
  }, [active, reduce, t]);
  const style = useAnimatedStyle(() => ({ opacity: t.get(), transform: [{ translateX: (1 - t.get()) * 16 }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** 8x8 border dot; the active one is a 24x8 accent pill (width 200 ms outQuart, instant when reduced). */
function Dot({ active, reduce }: { active: boolean; reduce: boolean }) {
  const w = useSharedValue(active ? 24 : 8);
  useEffect(() => {
    const to = active ? 24 : 8;
    w.set(reduce ? to : withTiming(to, { duration: motion.duration.base, easing: ease.outQuart }));
  }, [active, reduce, w]);
  const style = useAnimatedStyle(() => ({ width: w.get() }));
  return <Animated.View style={[styles.dot, { backgroundColor: active ? color.accent : color.border }, style]} />;
}

const styles = StyleSheet.create({
  column: { paddingHorizontal: 0 },
  flex: { flex: 1 },
  top: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: layout.gutter,
    paddingRight: space.sm,
    marginBottom: space.lg,
  },
  page: { paddingHorizontal: layout.gutter },
  headline: { marginTop: space.xxl },
  body: { marginTop: space.md },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space.sm, marginBottom: space.xl },
  dot: { height: 8, borderRadius: radius.pill },
  action: { paddingHorizontal: layout.gutter, paddingBottom: space.lg },
});
