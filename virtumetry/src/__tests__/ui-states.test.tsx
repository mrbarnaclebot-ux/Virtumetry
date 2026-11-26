import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, StyleSheet } from 'react-native';

import { ProgressBar } from '@/components/ui/progress-bar';
import { Skeleton, SkeletonRow } from '@/components/ui/skeleton';
import { color } from '@/design/tokens';

jest.mock('expo-symbols', () => ({ SymbolView: jest.fn(() => null) }));

const flat = (el: { props: { style?: unknown } }) => StyleSheet.flatten(el.props.style as never) ?? {};
const HIDDEN = { includeHiddenElements: true } as const;
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
