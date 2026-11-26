import { coachText, isSeen, markSeen } from '@/viewer/coach';

const mem = (init: Record<string, string> = {}) => {
  const m = { ...init };
  return { m, getItem: jest.fn((k: string) => m[k] ?? null), setItem: jest.fn((k: string, v: string) => void (m[k] = v)) };
};
const broken = {
  getItem: () => {
    throw new Error('private');
  },
  setItem: () => {
    throw new Error('private');
  },
};

it('prop list wins when defined', () => {
  const s = mem({ 'vm.coach.measure': '1' });
  expect(isSeen('walk', ['walk'], s)).toBe(true);
  expect(isSeen('measure', [], s)).toBe(false);
});

it('falls back to localStorage', () => {
  expect(isSeen('walk', undefined, mem({ 'vm.coach.walk': '1' }))).toBe(true);
  expect(isSeen('walk', undefined, mem())).toBe(false);
});

it('markSeen calls the native action and skips storage', () => {
  const s = mem();
  const cb = jest.fn(() => Promise.resolve());
  markSeen('measure', cb, s);
  expect(cb).toHaveBeenCalledWith('measure');
  expect(s.setItem).not.toHaveBeenCalled();
});

it('markSeen without callback writes localStorage', () => {
  const s = mem();
  markSeen('measure', undefined, s);
  expect(s.m['vm.coach.measure']).toBe('1');
});

it('throwing storage: not seen, markSeen does not throw', () => {
  expect(isSeen('walk', undefined, broken)).toBe(false);
  expect(() => markSeen('walk', undefined, broken)).not.toThrow();
});

it('coach texts (UI-SPEC §8.2)', () => {
  expect(coachText('walk', true)).toBe('Drag on the left to move. Drag on the right to look around.');
  expect(coachText('walk', false)).toBe('Use WASD or the arrow keys to move. Drag to look around.');
  expect(coachText('measure', true)).toBe('Tap two points on a surface. The distance shows here.');
  expect(coachText('measure', false)).toBe('Click two points on a surface. The distance shows here.');
});
