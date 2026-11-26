import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SymbolView } from 'expo-symbols';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { Banner } from '@/components/ui/banner';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Skeleton, SkeletonRow } from '@/components/ui/skeleton';
import { color } from '@/design/tokens';

jest.mock('expo-symbols', () => ({ SymbolView: jest.fn(() => null) }));

const flat = (el: { props: { style?: unknown } }) => StyleSheet.flatten(el.props.style as never) ?? {};
const HIDDEN = { includeHiddenElements: true } as const;
const tintOf = (sf: string) =>
  jest
    .mocked(SymbolView)
    .mock.calls.map((c) => c[0])
    .filter((p) => (p.name as { ios: string }).ios === sf)
    .at(-1)?.tintColor;
const settle = () => act(async () => {});

// Reanimated's jest animations advance on fake timers; advance inside an async act (sync act breaks RNTL 14 cleanup).
beforeEach(() => jest.useFakeTimers());

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ProgressBar', () => {
  it('determinate: progressbar role and value, keeps testID', async () => {
    await render(<ProgressBar value={40} testID="row-progress" accessibilityLabel="Upload progress" />);
    const bar = screen.getByTestId('row-progress');
    expect(bar.props.accessibilityRole).toBe('progressbar');
    expect(bar.props.accessibilityLabel).toBe('Upload progress');
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 40 });
  });

  it('null value is indeterminate: no now, busy', async () => {
    await render(<ProgressBar value={null} testID="p" />);
    const bar = screen.getByTestId('p');
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 100 });
    expect(bar.props.accessibilityState).toMatchObject({ busy: true });
  });

  it('tone success fills with color.success, default accent', async () => {
    await render(<ProgressBar value={100} tone="success" testID="a" />);
    expect(flat(screen.getByTestId('a-fill')).backgroundColor).toBe(color.success);
    await render(<ProgressBar value={10} testID="b" />);
    expect(flat(screen.getByTestId('b-fill')).backgroundColor).toBe(color.accent);
  });

  it('Reduce Motion: indeterminate segment stays put at the left', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await render(<ProgressBar value={null} testID="p" />);
    await settle();
    const fill = screen.getByTestId('p-fill');
    expect(fill).toHaveAnimatedStyle({ left: '0%', width: '30%' });
    await act(async () => jest.advanceTimersByTime(600));
    expect(fill).toHaveAnimatedStyle({ left: '0%' });
  });

  it('Reduce Motion: determinate width jumps', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await render(<ProgressBar value={10} testID="p" />);
    await settle();
    await screen.rerender(<ProgressBar value={80} testID="p" />);
    await act(async () => jest.advanceTimersByTime(16));
    expect(screen.getByTestId('p-fill')).toHaveAnimatedStyle({ width: '80%' });
  });
});

describe('Skeleton', () => {
  it('is hidden from screen readers', async () => {
    await render(<Skeleton width={160} height={32} testID="s" />);
    expect(screen.getByTestId('s', HIDDEN).props.accessible).toBe(false);
  });

  it('SkeletonRow: 64 thumb + two bars', async () => {
    await render(<SkeletonRow testID="row" />);
    const blocks: { width: unknown; height: unknown }[] = [];
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      const node = n as { props: { style?: unknown }; children?: unknown };
      const st = StyleSheet.flatten(node.props.style as never);
      if (st?.backgroundColor === color.surface.raised) blocks.push({ width: st.width, height: st.height });
      walk(node.children);
    };
    walk(screen.toJSON());
    expect(blocks).toEqual([
      { width: 64, height: 64 },
      { width: '70%', height: 16 },
      { width: '40%', height: 14 },
    ]);
  });

  it('Reduce Motion: static opacity 0.7', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await render(<Skeleton width={100} height={16} testID="s" />);
    await settle();
    await act(async () => jest.advanceTimersByTime(600));
    expect(screen.getByTestId('s', HIDDEN)).toHaveAnimatedStyle({ opacity: 0.7 });
  });

  it('shimmers when motion is allowed', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    await render(<Skeleton width={100} height={16} testID="s" />);
    await settle();
    await act(async () => jest.advanceTimersByTime(600));
    expect(screen.getByTestId('s', HIDDEN)).not.toHaveAnimatedStyle({ opacity: 0.7 });
  });
});

describe('Banner', () => {
  it('warning: alert role, title + body, warning icon, dismiss and action buttons', async () => {
    const onDismiss = jest.fn();
    const onPress = jest.fn();
    await render(
      <Banner
        tone="warning"
        icon="warning"
        title="You've used most of this month's budget"
        body="Approvals pause at the cap."
        onDismiss={onDismiss}
        dismissLabel="Dismiss budget alert"
        action={{ label: 'Refresh', onPress }}
        testID="b"
      />,
    );
    const banner = screen.getByTestId('b');
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(flat(banner).backgroundColor).toBe(color.warningSurface);
    expect(flat(banner).borderLeftWidth).toBeUndefined();
    expect(screen.getByText("You've used most of this month's budget")).toBeTruthy();
    expect(screen.getByText('Approvals pause at the cap.')).toBeTruthy();
    expect(tintOf('exclamationmark.triangle.fill')).toBe(color.warning);
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss budget alert' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('neutral: no alert role, raised surface, muted icon, no dismiss', async () => {
    await render(<Banner tone="neutral" icon="offline" title="You're offline." testID="b" />);
    const banner = screen.getByTestId('b');
    expect(banner.props.accessibilityRole).toBeUndefined();
    expect(flat(banner).backgroundColor).toBe(color.surface.raised);
    expect(tintOf('wifi.slash')).toBe(color.textMuted);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('danger uses the danger surface and alert role', async () => {
    await render(<Banner tone="danger" icon="failedCheck" title="Upload failed" testID="b" />);
    expect(screen.getByTestId('b').props.accessibilityRole).toBe('alert');
    expect(flat(screen.getByTestId('b')).backgroundColor).toBe(color.dangerSurface);
  });
});

describe('EmptyState', () => {
  const steps = ['Scan the room slowly', 'Check the cost, then approve', 'Walk, measure and share'];

  it('art, heading, body, numbered steps and a primary action', async () => {
    const onPress = jest.fn();
    await render(
      <EmptyState
        art={<View testID="art" />}
        title="No scans yet"
        body="Your rooms show up here."
        steps={steps}
        action={{ label: 'Scan a room', icon: 'newScan', onPress }}
      />,
    );
    expect(screen.getByTestId('art')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'No scans yet' })).toBeTruthy();
    expect(screen.getByText('Your rooms show up here.')).toBeTruthy();
    for (const n of ['01', '02', '03']) expect(screen.getByText(n)).toBeTruthy();
    for (const s of steps) expect(screen.getByText(s)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Scan a room' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('compact: icon + title + body, no art', async () => {
    await render(<EmptyState compact icon="link" art={<View testID="art" />} title="No links yet" body="Create one to share." />);
    expect(screen.queryByTestId('art')).toBeNull();
    expect(tintOf('link')).toBe(color.textMuted);
    expect(screen.getByText('No links yet')).toBeTruthy();
    expect(screen.getByText('Create one to share.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ErrorState', () => {
  it('48 icon, header title, body, secondary Try again', async () => {
    const onPress = jest.fn();
    await render(
      <ErrorState
        icon="warning"
        title="Couldn't load your scans"
        body="Check your connection, then try again."
        action={{ label: 'Try again', onPress }}
      />,
    );
    const icon = jest.mocked(SymbolView).mock.calls.at(-1)![0];
    expect(icon.size).toBe(48);
    expect(icon.tintColor).toBe(color.textMuted);
    expect(screen.getByRole('header', { name: "Couldn't load your scans" })).toBeTruthy();
    expect(screen.getByText('Check your connection, then try again.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('danger tints the icon; cap limits font scaling', async () => {
    await render(<ErrorState tone="danger" icon="failedCheck" title="Upload blocked" body="Not charged." cap={1.3} />);
    expect(tintOf('xmark.circle.fill')).toBe(color.danger);
    expect(screen.getByText('Upload blocked').props.maxFontSizeMultiplier).toBe(1.3);
  });
});
