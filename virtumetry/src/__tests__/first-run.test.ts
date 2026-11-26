import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import {
  __resetFirstRunForTest,
  consumeIntent,
  getOnboarded,
  getOnboardingSkipped,
  isCoachSeen,
  markCoachSeen,
  markOnboarded,
  markOnboardingSkipped,
  resetCoachMarks,
  useOnboarded,
} from '@/design/first-run';

const secure = jest.requireMock('expo-secure-store') as { __store: Map<string, string>; __reset: () => void };

beforeEach(() => {
  secure.__reset();
  __resetFirstRunForTest();
});
afterEach(() => jest.restoreAllMocks());

describe('onboarding flag', () => {
  it('is false on a fresh store and persists when marked', () => {
    expect(getOnboarded()).toBe(false);
    markOnboarded();
    expect(secure.__store.get('vm.onboarding.v1')).toBe('1');
    __resetFirstRunForTest();
    expect(getOnboarded()).toBe(true);
  });

  it('notifies useOnboarded subscribers', async () => {
    const { result } = await renderHook(() => useOnboarded());
    expect(result.current).toBe(false);
    await act(() => markOnboarded());
    expect(result.current).toBe(true);
  });

  it('hands out the scan intent exactly once', () => {
    markOnboarded('scan');
    expect(consumeIntent()).toBe('scan');
    expect(consumeIntent()).toBeNull();
    markOnboarded();
    expect(consumeIntent()).toBeNull();
  });

  it('records skip versus finish and persists it (critique F3)', () => {
    expect(getOnboardingSkipped()).toBe(false);
    markOnboardingSkipped(true);
    __resetFirstRunForTest();
    expect(getOnboardingSkipped()).toBe(true);
    markOnboardingSkipped(false);
    __resetFirstRunForTest();
    expect(getOnboardingSkipped()).toBe(false);
  });

  it('is always onboarded on web', () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    expect(getOnboarded()).toBe(true);
    expect(getOnboardingSkipped()).toBe(true);
  });
});

describe('coach marks', () => {
  it('marks, reads and resets only the coach keys', async () => {
    expect(isCoachSeen('walk')).toBe(false);
    markCoachSeen('walk');
    expect(isCoachSeen('walk')).toBe(true);
    expect(secure.__store.get('vm.coach.walk')).toBe('1');
    markCoachSeen('capture-prep');
    markCoachSeen('measure');
    markOnboarded();
    resetCoachMarks();
    await Promise.resolve();
    for (const id of ['capture-prep', 'walk', 'measure']) expect(secure.__store.has(`vm.coach.${id}`)).toBe(false);
    expect(secure.__store.get('vm.onboarding.v1')).toBe('1');
  });
});
