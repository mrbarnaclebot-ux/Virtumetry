import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { AccessibilityInfo, Platform } from 'react-native';

import { haptic } from '@/design/haptics';
import { useReduceMotion } from '@/design/motion';

afterEach(() => jest.restoreAllMocks());

describe('haptic', () => {
  it('maps to expo-haptics calls', () => {
    const notif = jest.spyOn(Haptics, 'notificationAsync').mockResolvedValue();
    const impact = jest.spyOn(Haptics, 'impactAsync').mockResolvedValue();
    const sel = jest.spyOn(Haptics, 'selectionAsync').mockResolvedValue();
    haptic.success();
    haptic.light();
    haptic.selection();
    expect(notif).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
    expect(impact).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
    expect(sel).toHaveBeenCalled();
  });

  it('is a no-op on web', () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const spies = [
      jest.spyOn(Haptics, 'notificationAsync'),
      jest.spyOn(Haptics, 'impactAsync'),
      jest.spyOn(Haptics, 'selectionAsync'),
    ];
    Object.values(haptic).forEach((h) => h());
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  });

  it('never throws when the native call rejects or throws', async () => {
    jest.spyOn(Haptics, 'notificationAsync').mockRejectedValue(new Error('no taptic'));
    jest.spyOn(Haptics, 'impactAsync').mockImplementation(() => {
      throw new Error('sync boom');
    });
    expect(() => haptic.error()).not.toThrow();
    expect(() => haptic.medium()).not.toThrow();
    await Promise.resolve();
  });
});

describe('useReduceMotion', () => {
  it('reads the OS setting and follows change events', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    let handler: (v: boolean) => void = () => {};
    const remove = jest.fn();
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((_e: string, h: (v: boolean) => void) => {
      handler = h;
      return { remove };
    }) as never);
    const { result, unmount } = await renderHook(() => useReduceMotion());
    await waitFor(() => expect(result.current).toBe(true));
    await act(() => handler(false));
    expect(result.current).toBe(false);
    await unmount();
    expect(remove).toHaveBeenCalled();
  });
});
