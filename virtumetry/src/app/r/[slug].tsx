import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import type { GenerateMetadataFunction } from 'expo-router/server';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError } from '@/lib/api';
import { getPublicShare, openPublicShare, type OpenedShare } from '@/lib/public-share';
import { loadViewer } from '@/viewer/load-viewer';
import { VT } from '@/viewer/tokens';

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

function Message({ heading, body, action, onPress }: { heading: string; body: string; action?: string; onPress?: () => void }) {
  return (
    <View style={styles.center}>
      <View style={styles.block}>
        <Text accessibilityRole="header" style={styles.heading}>
          {heading}
        </Text>
        <Text style={styles.body}>{body}</Text>
        {action && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action}
            onPress={onPress}
            style={({ pressed }) => [styles.secondary, { backgroundColor: pressed ? VT.color.surface.pressed : VT.color.surface.raised }]}>
            <Text style={styles.secondaryLabel}>{action}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** D-20 / SHARE-03: robots in the first HTML bytes (SDK 58 Head only lands after hydration). Server-only, stripped from the client. */
export const generateMetadata: GenerateMetadataFunction = () => ({ title: 'Virtumetry', robots: 'noindex,nofollow' });

/** D-19 public web share page: no session, no upload manager, always dark (UI-SPEC F). */
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
      <View style={styles.center}>
        <ActivityIndicator testID="share-checking" color={VT.color.primary} />
      </View>
    );
  } else if (state.k === 'notFound') {
    content = (
      <Message
        heading="This link is no longer available"
        body="The owner may have turned it off. Ask them for a new link."
      />
    );
  } else if (state.k === 'error') {
    content = (
      <Message
        heading="Couldn't open this room"
        body="Check your connection, then try again."
        action="Try again"
        onPress={retry}
      />
    );
  } else if (state.k === 'gate') {
    content = (
      <View style={styles.center}>
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.heading}>
            This room is password protected
          </Text>
          <Text style={styles.body}>Enter the password the owner gave you.</Text>
          <Text nativeID="share-pw-label" style={styles.label}>
            Password
          </Text>
          <TextInput
            ref={inputRef}
            accessibilityLabel="Password"
            aria-labelledby="share-pw-label"
            aria-describedby={gateError ? 'share-pw-error' : undefined}
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={submit}
            secureTextEntry
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="go"
            style={styles.input}
          />
          {gateError && (
            <Text nativeID="share-pw-error" accessibilityLiveRegion="polite" style={styles.error}>
              {gateError}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={submitting ? 'Opening…' : 'Open room'}
            accessibilityState={{ disabled: submitting }}
            disabled={submitting}
            onPress={submit}
            style={({ pressed }) => [styles.primary, (pressed || submitting) && { opacity: 0.8 }]}>
            <Text style={styles.primaryLabel}>{submitting ? 'Opening…' : 'Open room'}</Text>
          </Pressable>
        </View>
      </View>
    );
  } else if (crashed) {
    content = (
      <Message
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
              <ActivityIndicator color={VT.color.primary} />
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
          <Text accessibilityRole="header" numberOfLines={1} ellipsizeMode="tail" style={styles.title}>
            {title}
          </Text>
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
  root: { flex: 1, backgroundColor: VT.color.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: VT.space.lg },
  block: { width: '100%', maxWidth: 400, alignItems: 'center' },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: VT.color.surface.raised,
    borderRadius: VT.radius.lg,
    padding: VT.space.xl,
  },
  heading: { color: VT.color.text, fontSize: VT.type.heading.fontSize, lineHeight: 28, fontWeight: '600', textAlign: 'center' },
  body: {
    color: VT.color.textMuted,
    fontSize: VT.type.body.fontSize,
    lineHeight: 24,
    textAlign: 'center',
    marginTop: VT.space.sm,
  },
  label: { color: VT.color.text, fontSize: VT.type.label.fontSize, lineHeight: 20, marginTop: VT.space.xl },
  input: {
    height: 48,
    marginTop: VT.space.sm,
    paddingHorizontal: VT.space.lg,
    borderRadius: VT.radius.md,
    backgroundColor: VT.color.surface.pressed,
    color: VT.color.text,
    fontSize: VT.type.body.fontSize,
  },
  error: { color: VT.color.danger, fontSize: VT.type.label.fontSize, lineHeight: 20, marginTop: VT.space.sm },
  primary: {
    height: 52,
    marginTop: VT.space.lg,
    borderRadius: VT.radius.md,
    backgroundColor: VT.color.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryLabel: { color: VT.color.onPrimary, fontSize: VT.type.body.fontSize, fontWeight: '600' },
  secondary: {
    marginTop: VT.space.xl,
    height: 44,
    paddingHorizontal: VT.space.xl,
    borderRadius: VT.radius.md,
    justifyContent: 'center',
  },
  secondaryLabel: { color: VT.color.text, fontSize: VT.type.body.fontSize, fontWeight: '600' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: TOP_BAR,
    justifyContent: 'center',
    paddingHorizontal: VT.space.lg,
    backgroundColor: VT.color.scrim.hud,
  },
  title: { color: VT.color.text, fontSize: VT.type.body.fontSize, fontWeight: '600' },
});
