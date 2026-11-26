import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, type ScrollViewInstance, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OnboardingArt } from '@/components/onboarding/art';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { markOnboardingSkipped } from '@/design/first-run';
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

/** UI-SPEC §8.1 + critique F3: full-bleed art field (top 52%), Skip over it, dots and primary button. */
export function OnboardingPager({ pages, ctaLabel, onFinish, onSkip, replay }: Props) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const scroller = useRef<ScrollViewInstance>(null);
  const [pageW, setPageW] = useState(Math.min(window.width, layout.maxContent));
  const [index, setIndex] = useState(0);
  const last = index === pages.length - 1;

  // UI review M4: large Dynamic Type shrinks the art, and each page scrolls vertically, so the copy never clips.
  const artH = Math.round(window.height * (window.fontScale > 1.3 ? 0.34 : 0.52));

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

  // Replay leaves the first-run record alone.
  const skip = () => {
    if (!replay) markOnboardingSkipped(true);
    onSkip();
  };
  const finish = () => {
    if (!replay) markOnboardingSkipped(false);
    onFinish();
  };

  return (
    <Screen edges={['bottom', 'left', 'right']} contentStyle={styles.column}>
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onLayout={(e) => setPageW(e.nativeEvent.layout.width)}
        onMomentumScrollEnd={onMomentumScrollEnd}
        style={styles.flex}>
        {pages.map((p, i) => (
          <ScrollView key={p.headline} style={{ width: pageW }} showsVerticalScrollIndicator={false} bounces={false}>
            <View accessible accessibilityLabel={`${p.headline}. ${p.body}`}>
              <OnboardingArt page={i as 0 | 1 | 2 | 3} width={pageW} height={artH} active={i === index} reduce={reduce} />
              <View style={styles.copy}>
                <ThemedText type="display">{p.headline}</ThemedText>
                <ThemedText type="body" tone="muted" style={styles.body}>
                  {p.body}
                </ThemedText>
              </View>
            </View>
          </ScrollView>
        ))}
      </ScrollView>
      <View style={[styles.top, { top: insets.top }]}>
        <Button variant="ghost" size="md" label={replay ? 'Close' : 'Skip'} onPress={skip} />
      </View>
      <View accessible accessibilityLabel={`Page ${index + 1} of ${pages.length}`} style={styles.dots}>
        {pages.map((p, i) => (
          <Dot key={p.headline} active={i === index} reduce={reduce} />
        ))}
      </View>
      <View style={styles.action}>
        <Button size="lg" label={last ? ctaLabel : 'Next'} onPress={last ? finish : next} />
      </View>
    </Screen>
  );
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
  top: { position: 'absolute', right: space.sm, height: 44, justifyContent: 'center' },
  copy: { paddingHorizontal: layout.gutter, paddingTop: space.xxl },
  body: { marginTop: space.md },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space.sm, marginBottom: space.xl },
  dot: { height: 8, borderRadius: radius.pill },
  action: { paddingHorizontal: layout.gutter, paddingBottom: space.lg },
});
