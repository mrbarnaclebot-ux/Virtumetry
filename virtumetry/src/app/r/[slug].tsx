import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import type { GenerateMetadataFunction } from 'expo-router/server';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { BrandMark } from '@/components/ui/brand-mark';
import { Button } from '@/components/ui/button';
import { Glyph } from '@/components/ui/glyph';
import { ProgressBar } from '@/components/ui/progress-bar';
import { TextField } from '@/components/ui/text-field';
import { color, radius, space } from '@/design/tokens';
import { ApiError } from '@/lib/api';
import { getPublicShare, openPublicShare, type OpenedShare } from '@/lib/public-share';
import { loadViewer } from '@/viewer/load-viewer';

// Pattern 10: never import the viewer statically. Spark compiles WASM at module load and three wants a DOM,
// so the server render must not evaluate it. 'opened' is only reachable from the fetch in an effect, and effects
// never run on the server, so the lazy viewer is first rendered after mount, in the browser.
const WorldViewer = lazy(loadViewer);

const TOP_BAR = 44;
const INSETS = { top: TOP_BAR, bottom: 0 };
const REOPEN_MS = 14 * 60_000; // public URLs live 15 min (D-17, Pitfall 11)
const WRONG = "That password isn't right. Try again.";
const LIMITED = 'Too many tries. Wait a minute, then try again.';

type State =
  | { k: 'checking' }
  | { k: 'notFound' }
  | { k: 'error' }
  | { k: 'gate'; title: string }
  | { k: 'opened'; data: OpenedShare };

const titleOf = (t: string | null | undefined) => t?.trim() || 'Untitled scan';

function Message({
  glyph,
  heading,
  body,
  action,
  onPress,
}: {
  glyph: ReactNode;
  heading: string;
  body: string;
  action?: string;
  onPress?: () => void;
}) {
  return (
    <View style={styles.center}>
      <View style={styles.block}>
        {glyph}
        <ThemedText type="heading" accessibilityRole="header" style={[styles.centerText, styles.gap16]}>
          {heading}
        </ThemedText>
        <ThemedText tone="muted" style={[styles.centerText, styles.gap8]}>
          {body}
        </ThemedText>
        {action && onPress && <Button variant="secondary" label={action} onPress={onPress} style={styles.gap24} />}
      </View>
    </View>
  );
}

/** Brand only: not a link, no upsell (T-06.1-24). */
function Footer() {
  return (
    <View style={styles.footer}>
      <BrandMark variant="lockup" size={20} mono />
    </View>
  );
}

/** D-20 / SHARE-03: robots in the first HTML bytes (SDK 58 Head only lands after hydration). Server-only, stripped from the client. */
export const generateMetadata: GenerateMetadataFunction = () => ({ title: 'Virtumetry', robots: 'noindex,nofollow' });

/** D-19 public web share page: no session, no upload manager, no toasts, no Icon font, always dark (UI-SPEC §7.13). */
export default function SharePage() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [state, setState] = useState<State>({ k: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState('');
  const [gateError, setGateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [crashed, setCrashed] = useState(false);
  const [viewerKey, setViewerKey] = useState(0);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  // Kept in memory for this tab only, for the one re-open (T-05-31). Never in the URL or storage.
  const keptPassword = useRef<string | undefined>(undefined);
  const openedAt = useRef(0);
  const reopened = useRef(false);

  const fail = useCallback((e: unknown) => {
    setState(e instanceof ApiError && e.status === 404 ? { k: 'notFound' } : { k: 'error' });
  }, []);

  const open = useCallback(
    async (pw?: string) => {
      const data = await openPublicShare(slug, pw);
      keptPassword.current = pw;
      openedAt.current = Date.now();
      reopened.current = false;
      setState({ k: 'opened', data });
    },
    [slug],
  );

  useEffect(() => {
    let live = true;
    getPublicShare(slug)
      .then((s) => {
        if (!live) return;
        if (s.needs_password) setState({ k: 'gate', title: titleOf(s.title) });
        else return open();
      })
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [slug, attempt, open, fail]);

  const retry = () => {
    setState({ k: 'checking' });
    setAttempt((a) => a + 1);
  };

  const submit = async () => {
    if (submitting || !password) return;
    setSubmitting(true);
    setGateError(null);
    try {
      await open(password);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setGateError(WRONG);
        setPassword('');
        inputRef.current?.focus();
      } else if (e instanceof ApiError && e.status === 429) {
        setGateError(LIMITED);
      } else {
        fail(e);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onError = useCallback(
    async (e: { code: string }) => {
      if (e.code === 'context_lost') return setCrashed(true);
      // Expired R2 403s carry no CORS headers, so any fetch failure after ~14 min means "re-open once".
      if (e.code !== 'load_failed' || reopened.current || Date.now() - openedAt.current < REOPEN_MS) return;
      reopened.current = true; // in-flight guard only
      try {
        const data = await openPublicShare(slug, keptPassword.current);
        // WR-05: a fresh 15-min window, so a later expiry can re-open again (REOPEN_MS blocks an instant repeat).
        openedAt.current = Date.now();
        setState({ k: 'opened', data });
        setViewerKey((k) => k + 1);
      } catch {
        // The viewer's own load error (B9) stays on screen.
      } finally {
        reopened.current = false;
      }
    },
    [slug],
  );

  const reload = () => {
    if (Platform.OS === 'web') window.location.reload();
    else {
      setCrashed(false);
      setViewerKey((k) => k + 1);
    }
  };

  const pageTitle =
    state.k === 'notFound'
      ? 'Link unavailable · Virtumetry'
      : state.k === 'gate'
        ? `${state.title} · Virtumetry`
        : state.k === 'opened'
          ? `${titleOf(state.data.title)} · Virtumetry`
          : 'Virtumetry';

  let content;
  if (state.k === 'checking') {
    content = (
      <View testID="share-checking" accessibilityLabel="Opening room" style={[styles.center, styles.checking]}>
        <BrandMark size={40} />
        <ProgressBar value={null} testID="share-checking-bar" accessibilityLabel="Opening room" style={styles.checkingBar} />
      </View>
    );
  } else if (state.k === 'notFound') {
    content = (
      <>
        <Message
          glyph={<Glyph id="linkOff" size={40} color={color.textMuted} />}
          heading="This link is no longer available"
          body="The owner may have turned it off. Ask them for a new link."
        />
        <Footer />
      </>
    );
  } else if (state.k === 'error') {
    content = (
      <>
        <Message
          glyph={<Glyph id="alert" size={40} color={color.textMuted} />}
          heading="Couldn't open this room"
          body="Check your connection, then try again."
          action="Try again"
          onPress={retry}
        />
        <Footer />
      </>
    );
  } else if (state.k === 'gate') {
    content = (
      <>
        <View style={styles.center}>
          <View style={styles.card}>
            <View style={styles.lockCircle}>
              <Glyph id="lock" size={24} color={color.text} />
            </View>
            <ThemedText type="heading" accessibilityRole="header" style={[styles.centerText, styles.gap16]}>
              This room is password protected
            </ThemedText>
            <ThemedText tone="muted" style={[styles.centerText, styles.gap8]}>
              Enter the password the owner gave you.
            </ThemedText>
            <View style={styles.gap24}>
              {/* TextField names the input (aria-label) and links its error (aria-describedby → its own id). */}
              <TextField
                ref={inputRef}
                label="Password"
                inGroup
                error={gateError}
                value={password}
                onChangeText={setPassword}
                onSubmitEditing={submit}
                secureTextEntry
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="go"
              />
            </View>
            <Button label="Open room" busy={submitting} busyLabel="Opening…" onPress={submit} style={styles.gap16} />
          </View>
        </View>
        <Footer />
      </>
    );
  } else if (crashed) {
    content = (
      <Message
        glyph={<Glyph id="alert" size={40} color={color.textMuted} />}
        heading="The viewer stopped working"
        body="This can happen when the phone is low on memory. Reload to try again."
        action="Reload page"
        onPress={reload}
      />
    );
  } else {
    const { data } = state;
    const title = titleOf(data.title);
    content = (
      <>
        <Suspense
          fallback={
            <View style={styles.center}>
              <ProgressBar value={null} accessibilityLabel="Opening room" style={styles.checkingBar} />
            </View>
          }>
          {data.assets.splat_url && (
            <WorldViewer
              key={viewerKey}
              splatUrl={data.assets.splat_url}
              colliderUrl={data.assets.collider_url}
              floorplanUrl={data.assets.floorplan_url}
              floorplanMeta={data.floorplan_meta}
              camerasUrl={data.assets.cameras_url}
              title={title}
              insets={INSETS}
              onError={onError}
            />
          )}
        </Suspense>
        <View style={styles.topBar}>
          <BrandMark size={20} />
          <ThemedText type="heading" accessibilityRole="header" numberOfLines={1} ellipsizeMode="tail" style={styles.title}>
            {title}
          </ThemedText>
        </View>
      </>
    );
  }

  return (
    <View style={styles.root}>
      <Head>
        <title>{pageTitle}</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  checking: { gap: space.lg },
  checkingBar: { width: 160 },
  block: { width: '100%', maxWidth: 400, alignItems: 'center' },
  centerText: { textAlign: 'center' },
  gap8: { marginTop: space.sm },
  gap16: { marginTop: space.lg },
  gap24: { marginTop: space.xl },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: color.surface.raised,
    borderRadius: radius.lg,
    padding: space.xl,
  },
  lockCircle: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface.overlay,
  },
  footer: { position: 'absolute', bottom: space.xl, left: 0, right: 0, alignItems: 'center' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: TOP_BAR,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    backgroundColor: color.scrim.hud,
  },
  title: { flex: 1 },
});
