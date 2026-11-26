import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Text } from 'react-native';

import { ToastProvider, __resetToastsForTest, toast } from '@/components/ui/toast';
import { haptic } from '@/design/haptics';

// Reanimated's setUpTests() matcher ships without jest typings.
declare global {
  namespace jest {
    interface Matchers<R> {
      toHaveAnimatedStyle(style: object): R;
    }
  }
}

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

const tick = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

async function mount() {
  await render(
    <ToastProvider>
      <Text>app</Text>
    </ToastProvider>,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetToastsForTest();
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const call = (fn: () => void) => act(async () => fn());

it('shows a success toast, announces it and fires one success haptic', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const success = jest.spyOn(haptic, 'success');
  await mount();
  await call(() => toast.success('Name saved'));
  expect(screen.getByText('Name saved')).toBeTruthy();
  expect(announce).toHaveBeenCalledWith('Name saved');
  expect(success).toHaveBeenCalledTimes(1);
});

it('success hides after 3000 ms, error after 6000 ms', async () => {
  await mount();
  await call(() => toast.success('Saved'));
  await tick(2999);
  expect(screen.queryByText('Saved')).toBeTruthy();
  await tick(1 + 150);
  expect(screen.queryByText('Saved')).toBeNull();

  await call(() => toast.error('Broke'));
  await tick(5999);
  expect(screen.queryByText('Broke')).toBeTruthy();
  await tick(1 + 150);
  expect(screen.queryByText('Broke')).toBeNull();
});

it('doubles the duration with a screen reader on', async () => {
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
  await mount();
  await call(() => toast.success('Saved'));
  await tick(5999);
  expect(screen.queryByText('Saved')).toBeTruthy();
  await tick(1 + 150);
  expect(screen.queryByText('Saved')).toBeNull();
});

it('queues FIFO, one visible, max 3 queued (oldest queued dropped)', async () => {
  await mount();
  await call(() => {
    toast.info('A');
    toast.info('B');
    toast.info('C');
  });
  expect(screen.getByText('A')).toBeTruthy();
  expect(screen.queryByText('B')).toBeNull();
  await tick(3150);
  expect(screen.getByText('B')).toBeTruthy();

  await call(__resetToastsForTest);
  await call(() => {
    toast.info('1');
    toast.info('2');
    toast.info('3');
    toast.info('4');
    toast.info('5');
  });
  await tick(3150);
  expect(screen.getByText('3')).toBeTruthy();
});

it('coalesces an identical visible message and restarts its timer', async () => {
  await mount();
  await call(() => toast.info('X'));
  await tick(2000);
  await call(() => toast.info('X'));
  expect(screen.getAllByText('X')).toHaveLength(1);
  await tick(2000);
  expect(screen.queryByText('X')).toBeTruthy();
  await tick(1000 + 150);
  expect(screen.queryByText('X')).toBeNull();
});

it('dismisses on press', async () => {
  await mount();
  await call(() => toast.info('Tap me'));
  await fireEvent.press(screen.getByHintText('Dismisses the message'));
  await tick(150);
  expect(screen.queryByText('Tap me')).toBeNull();
});

it('error is an alert; info fires no haptic', async () => {
  const success = jest.spyOn(haptic, 'success');
  const error = jest.spyOn(haptic, 'error');
  await mount();
  await call(() => toast.info('Note'));
  expect(success).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  await call(() => toast.error('Bad'));
  await tick(3150);
  expect(screen.getByRole('alert', { name: 'Bad' })).toBeTruthy();
  expect(error).toHaveBeenCalledTimes(1);
});

it('reduce motion: shows and hides with opacity only (no translate)', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  await mount();
  await call(() => toast.info('Calm'));
  await tick(200);
  expect(screen.getByTestId('toast')).toHaveAnimatedStyle({ opacity: 1, transform: [{ translateY: 0 }] });
  await tick(3000);
  expect(screen.queryByText('Calm')).toBeNull();
});
