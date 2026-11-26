import { coachText, isSeen, markSeen, outExpo, REVEAL_MS, revealAt, urlScope } from '@/viewer/coach';

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

describe('first-open reveal (critique R1 #9)', () => {
  it('starts pulled back 1.25x with 15° yaw and lands exactly on the start pose at 900 ms', () => {
    expect(REVEAL_MS).toBe(900);
    expect(revealAt(0)).toEqual({ scale: 1.25, yaw: (15 * Math.PI) / 180, done: false });
    expect(revealAt(900)).toEqual({ scale: 1, yaw: 0, done: true });
    expect(revealAt(5000)).toEqual({ scale: 1, yaw: 0, done: true });
    expect(revealAt(-10).scale).toBe(1.25);
  });

  it('eases out (outExpo): most of the move happens early, monotonic', () => {
    expect(outExpo(0)).toBe(0);
    expect(outExpo(1)).toBe(1);
    expect(outExpo(0.25)).toBeGreaterThan(0.8);
    const s = [0, 100, 300, 600, 899, 900].map((ms) => revealAt(ms).scale);
    s.slice(1).forEach((v, i) => expect(v).toBeLessThanOrEqual(s[i]));
  });

  it('reveal is remembered per world on web (URL path scope, query ignored)', () => {
    const s = mem();
    const a = urlScope('https://r2.test/worlds/a/splat.spz?X-Amz-Signature=1');
    expect(a).toBe('https://r2.test/worlds/a/splat.spz');
    markSeen('reveal', undefined, s, a);
    expect(isSeen('reveal', undefined, s, urlScope('https://r2.test/worlds/a/splat.spz?X-Amz-Signature=2'))).toBe(true);
    expect(isSeen('reveal', undefined, s, urlScope('https://r2.test/worlds/b/splat.spz'))).toBe(false);
    expect(isSeen('walk', undefined, s)).toBe(false);
  });

  it('app prop list carries reveal for this world', () => {
    expect(isSeen('reveal', ['walk', 'reveal'], mem())).toBe(true);
    expect(isSeen('reveal', ['walk'], mem({ 'vm.coach.reveal.x': '1' }), 'x')).toBe(false);
  });
});
