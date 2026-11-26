import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { CoachMark, __resetCoachLockForTest, dismissCoach } from '@/components/ui/coach-mark';
import { __resetFirstRunForTest, isCoachSeen, markCoachSeen } from '@/design/first-run';

// Reanimated's setUpTests() matcher ships without jest typings.
declare global {
  namespace jest {
    interface Matchers<R> {
      toHaveAnimatedStyle(style: object): R;
    }
  }
}

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

const anchor = { x: 20, y: 100, width: 120, height: 120 };
const TEXT = 'Fill the ring.';
const tick = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

beforeEach(() => {
  jest.useFakeTimers();
  (jest.requireMock('expo-secure-store') as { __reset: () => void }).__reset();
  __resetFirstRunForTest();
  __resetCoachLockForTest();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('renders text as an alert with Got it; Got it marks seen and calls onDismiss', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const onDismiss = jest.fn();
  await render(<CoachMark id="capture-prep" text={TEXT} anchor={anchor} placement="below" onDismiss={onDismiss} />);
  expect(screen.getByRole('alert', { name: TEXT })).toBeTruthy();
  expect(announce).toHaveBeenCalledTimes(1);
  expect(announce).toHaveBeenCalledWith(TEXT);

  await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(isCoachSeen('capture-prep')).toBe(true);
  await tick(150);
  expect(screen.queryByText(TEXT)).toBeNull();
});

it('renders nothing once seen', async () => {
  markCoachSeen('capture-prep');
  await render(<CoachMark id="capture-prep" text={TEXT} anchor={anchor} placement="below" onDismiss={jest.fn()} />);
  expect(screen.queryByText(TEXT)).toBeNull();
});

it('renders nothing while visible is false', async () => {
  await render(
    <CoachMark id="capture-prep" text={TEXT} anchor={anchor} placement="below" visible={false} onDismiss={jest.fn()} />,
  );
  expect(screen.queryByText(TEXT)).toBeNull();
});

it('lock: a second mark waits until the first is dismissed', async () => {
  await render(
    <>
      <CoachMark id="capture-prep" text="First" anchor={anchor} placement="below" onDismiss={jest.fn()} />
      <CoachMark id="walk" text="Second" anchor={anchor} placement="above" onDismiss={jest.fn()} />
    </>,
  );
  expect(screen.getByText('First')).toBeTruthy();
  expect(screen.queryByText('Second')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
  await tick(100);
  expect(screen.getByText('First')).toBeTruthy(); // still running its 150 ms exit
  expect(screen.queryByText('Second')).toBeNull();
  await tick(50);
  expect(screen.queryByText('First')).toBeNull();
  expect(screen.getByText('Second')).toBeTruthy();
});

it('dismissCoach closes it from an external trigger without calling onDismiss', async () => {
  const onDismiss = jest.fn();
  await render(<CoachMark id="capture-prep" text={TEXT} anchor={anchor} placement="below" onDismiss={onDismiss} />);
  await act(async () => dismissCoach('capture-prep'));
  await tick(150);
  expect(onDismiss).not.toHaveBeenCalled();
  expect(isCoachSeen('capture-prep')).toBe(true);
  expect(screen.queryByText(TEXT)).toBeNull();
});

it('reduce motion: opacity only, then dismisses', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  await render(<CoachMark id="capture-prep" text={TEXT} anchor={anchor} placement="below" onDismiss={jest.fn()} />);
  await tick(200);
  expect(screen.getByTestId('coach-mark')).toHaveAnimatedStyle({ opacity: 1, transform: [{ translateY: 0 }] });
  await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
  await tick(150);
  expect(screen.queryByText(TEXT)).toBeNull();
});
