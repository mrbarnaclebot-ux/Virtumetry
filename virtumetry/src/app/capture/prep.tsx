import { useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState, Linking, Platform, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { getPrepFlags, markPermissionAsked, markPrepSeen, setSkipPrep } from '@/capture/prep-flags';
import { getCaptureSource, isFixtureSource } from '@/capture/source';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import { Icon, type IconName } from '@/components/ui/icon';
import { Group } from '@/components/ui/list-row';
import { Screen } from '@/components/ui/screen';
import { Surface } from '@/components/ui/surface';
import { haptic } from '@/design/haptics';
import { color, minTarget, space } from '@/design/tokens';

const CHECKLIST: { icon: IconName; title: string; body: string }[] = [
  { icon: 'lights', title: 'Turn the lights on', body: 'Bright, even light gives the sharpest room.' },
  { icon: 'doors', title: 'Open the doors', body: 'Open doors to any area you want in the scan.' },
  {
    icon: 'glare',
    title: 'Watch for mirrors and glare',
    body: "Mirrors, glass and bright windows confuse the scan. Don't point straight at them.",
  },
  { icon: 'walk', title: 'Walk slowly', body: 'Move at half your normal pace and look around as you go.' },
];

const DENIED_HEADING = 'Camera access is off';

const close = () => router.back();
const goScan = () => router.replace('/capture/scan');

export default function PrepScreen() {
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
    haptic.selection();
    setSkip(v);
    setSkipPrep(v);
  };

  return (
    <Screen>
      <View style={styles.topBar}>
        <Button variant="ghost" size="md" label="Cancel" onPress={close} style={styles.inline} />
      </View>
      {denied ? (
        <View style={styles.denied} accessibilityLiveRegion="polite">
          <ErrorState
            icon="cameraOff"
            title={DENIED_HEADING}
            body="To scan a room, turn on camera access for Virtumetry in Settings.">
            <View style={styles.deniedActions}>
              <Button label="Open Settings" onPress={() => Linking.openSettings()} />
              {fixture && <Button variant="ghost" label="Use test capture" onPress={goScan} />}
              <Button variant="ghost" label="Not now" onPress={close} />
            </View>
          </ErrorState>
        </View>
      ) : (
        <>
          <ScrollView style={styles.flex} contentContainerStyle={styles.scroll}>
            <ThemedText type="title" accessibilityRole="header">
              Before you scan
            </ThemedText>
            {flags.seen ? (
              <>
                <ThemedText type="label" tone="muted" style={styles.compactLine}>
                  Lights on · Doors open · No mirrors · Walk slowly
                </ThemedText>
                <View style={styles.block}>
                  <Group>
                    <View style={styles.switchRow}>
                      <ThemedText type="bodyStrong" style={styles.flex}>
                        {"Don't show again"}
                      </ThemedText>
                      <Switch
                        accessibilityRole="switch"
                        accessibilityLabel="Don't show again"
                        accessibilityState={{ checked: skip }}
                        value={skip}
                        onValueChange={toggleSkip}
                        trackColor={{ true: color.primary, false: color.surface.pressed }}
                        ios_backgroundColor={color.surface.pressed}
                      />
                    </View>
                  </Group>
                </View>
              </>
            ) : (
              <>
                <View style={styles.checklist}>
                  {CHECKLIST.map((c) => (
                    <View key={c.title} accessible accessibilityLabel={`${c.title}. ${c.body}`} style={styles.checkRow}>
                      <View style={styles.badge}>
                        <Icon name={c.icon} size={20} />
                      </View>
                      <View style={styles.flex}>
                        <ThemedText type="bodyStrong">{c.title}</ThemedText>
                        <ThemedText type="label" tone="muted">
                          {c.body}
                        </ThemedText>
                      </View>
                    </View>
                  ))}
                </View>
                <Surface padded style={styles.block}>
                  <View style={styles.cardHead}>
                    <Icon name="camera" size={20} />
                    <ThemedText type="heading">Camera access</ThemedText>
                  </View>
                  <ThemedText type="body" style={styles.cardBody}>
                    Virtumetry uses the camera only while you scan. Photos stay on your phone until you choose to
                    upload them.
                  </ThemedText>
                </Surface>
              </>
            )}
          </ScrollView>
          <View style={styles.pinned}>
            <Button label="Continue" busy={asking} onPress={onContinue} />
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingTop: space.lg, paddingBottom: space.xl },
  inline: { alignSelf: 'flex-start' },
  topBar: { height: minTarget, flexDirection: 'row', alignItems: 'center' },
  checklist: { marginTop: space.xl, gap: space.lg },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.surface.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  block: { marginTop: space.xl },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardBody: { marginTop: space.sm },
  compactLine: { marginTop: space.sm },
  switchRow: { minHeight: minTarget, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  pinned: { paddingTop: space.md, paddingBottom: space.lg },
  denied: { flex: 1, justifyContent: 'center' },
  deniedActions: { marginTop: space.md, alignSelf: 'stretch', gap: space.md },
});
