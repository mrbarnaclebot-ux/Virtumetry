import { useCameraPermissions } from 'expo-camera';
import { router, type Href } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getPrepFlags, markPermissionAsked, markPrepSeen, setSkipPrep } from '@/capture/prep-flags';
import { getCaptureSource, isFixtureSource } from '@/capture/source';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const CHECKLIST: { icon: SymbolViewProps['name']; title: string; body: string }[] = [
  { icon: 'lightbulb', title: 'Turn the lights on', body: 'Bright, even light gives the sharpest room.' },
  { icon: 'door.left.hand.open', title: 'Open the doors', body: 'Open doors to any area you want in the scan.' },
  {
    icon: 'sun.max',
    title: 'Watch for mirrors and glare',
    body: "Mirrors, glass and bright windows confuse the scan. Don't point straight at them.",
  },
  { icon: 'figure.walk', title: 'Walk slowly', body: 'Move at half your normal pace and look around as you go.' },
];

const DENIED_HEADING = 'Camera access is off';

const close = () => router.back();
const goScan = () => router.replace('/capture/scan' as Href);

export default function PrepScreen() {
  const theme = useTheme();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [flags] = useState(getPrepFlags);
  const [skip, setSkip] = useState(flags.skip);
  const [asking, setAsking] = useState(false);
  const [deniedAfterAsk, setDeniedAfterAsk] = useState(false);
  const fixture = isFixtureSource(getCaptureSource());

  const denied =
    !permission?.granted && (deniedAfterAsk || (permission?.status === 'denied' && !permission.canAskAgain));

  // Coming back from Settings: re-read the permission (UI-SPEC §3).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') getPermission().then((p) => p.granted && setDeniedAfterAsk(false));
    });
    return () => sub.remove();
  }, [getPermission]);

  useEffect(() => {
    if (denied && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(DENIED_HEADING);
  }, [denied]);

  async function onContinue() {
    markPrepSeen();
    if (permission?.granted) return goScan();
    setAsking(true);
    markPermissionAsked();
    try {
      const res = await requestPermission();
      if (res.granted) goScan();
      else setDeniedAfterAsk(true);
    } finally {
      setAsking(false);
    }
  }

  const toggleSkip = (v: boolean) => {
    setSkip(v);
    setSkipPrep(v);
  };

  const primary = (label: string, onPress: () => void, busy = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: theme.accent }, pressed && styles.pressed]}>
      {busy ? (
        <ActivityIndicator color={theme.onAccent} />
      ) : (
        <ThemedText type="smallBold" themeColor="onAccent" maxFontSizeMultiplier={1.6}>
          {label}
        </ThemedText>
      )}
    </Pressable>
  );

  const textButton = (label: string, onPress: () => void, bold = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
      <ThemedText type={bold ? 'smallBold' : 'default'} maxFontSizeMultiplier={1.6}>
        {label}
      </ThemedText>
    </Pressable>
  );

  return (
    <ThemedView style={styles.flex}>
      <SafeAreaView style={styles.flex}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={close}
            style={({ pressed }) => [styles.topButton, pressed && styles.pressed]}>
            <ThemedText maxFontSizeMultiplier={1.6}>Cancel</ThemedText>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          {denied ? (
            <View style={styles.denied}>
              <View accessible={false}>
                <SymbolView name="video.slash" size={48} tintColor={theme.textSecondary} />
              </View>
              <ThemedText
                type="subtitle"
                accessibilityRole="header"
                accessibilityLiveRegion="polite"
                style={styles.deniedHeading}>
                {DENIED_HEADING}
              </ThemedText>
              <ThemedText style={styles.textCenter}>
                To scan a room, turn on camera access for Virtumetry in Settings.
              </ThemedText>
              <View style={styles.deniedActions}>
                {primary('Open Settings', () => Linking.openSettings())}
                {fixture && textButton('Use test capture', goScan, true)}
                {textButton('Not now', close)}
              </View>
            </View>
          ) : (
            <>
              <ThemedText type="title" accessibilityRole="header">
                Before you scan
              </ThemedText>
              {flags.seen ? (
                <>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.compactLine}>
                    Lights on · Doors open · No mirrors · Walk slowly
                  </ThemedText>
                  <View style={styles.switchRow}>
                    <ThemedText style={styles.flex}>{"Don't show again"}</ThemedText>
                    <Switch
                      accessibilityRole="switch"
                      accessibilityLabel="Don't show again"
                      accessibilityState={{ checked: skip }}
                      value={skip}
                      onValueChange={toggleSkip}
                      trackColor={{ true: theme.accent, false: theme.backgroundSelected }}
                    />
                  </View>
                </>
              ) : (
                <>
                  <View style={styles.checklist}>
                    {CHECKLIST.map((c) => (
                      <View key={c.title} accessible accessibilityLabel={`${c.title}. ${c.body}`} style={styles.checkRow}>
                        <SymbolView name={c.icon} size={24} tintColor={theme.text} />
                        <View style={styles.flex}>
                          <ThemedText type="smallBold">{c.title}</ThemedText>
                          <ThemedText type="small" themeColor="textSecondary" style={styles.checkBody}>
                            {c.body}
                          </ThemedText>
                        </View>
                      </View>
                    ))}
                  </View>
                  <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
                    <View style={styles.cardHead}>
                      <SymbolView name="camera" size={24} tintColor={theme.text} />
                      <ThemedText type="subtitle">Camera access</ThemedText>
                    </View>
                    <ThemedText style={styles.cardBody}>
                      Virtumetry uses the camera only while you scan. Photos stay on your phone until you choose to
                      upload them.
                    </ThemedText>
                  </View>
                </>
              )}
              <View style={styles.action}>{primary('Continue', onContinue, asking)}</View>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  topBar: { height: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.three },
  topButton: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.four,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  checklist: { marginTop: Spacing.four, gap: Spacing.three },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.three },
  checkBody: { marginTop: Spacing.two },
  card: { marginTop: Spacing.four, borderRadius: 12, padding: Spacing.three },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  cardBody: { marginTop: Spacing.two },
  compactLine: { marginTop: Spacing.two },
  switchRow: { marginTop: Spacing.four, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  action: { marginTop: Spacing.five },
  button: { height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  pressed: { opacity: 0.8 },
  textButton: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  denied: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  deniedHeading: { marginTop: Spacing.three, marginBottom: Spacing.two, textAlign: 'center' },
  textCenter: { textAlign: 'center' },
  deniedActions: { marginTop: Spacing.four, alignSelf: 'stretch', gap: Spacing.three },
});
