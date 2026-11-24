import { announceDistance, distance, formatDistance, isTap } from '@/viewer/measure';

describe('measure', () => {
  it('distance between two points', () => {
    expect(distance([0, 0, 0], [2.41, 0, 0])).toBeCloseTo(2.41, 10);
    expect(distance([1, 2, 3], [4, 6, 3])).toBeCloseTo(5, 10);
  });

  it('formats 2 decimals, approximate', () => {
    expect(formatDistance(2.4149)).toBe('≈ 2.41 m (approx.)');
    expect(formatDistance(0.07)).toBe('≈ 0.07 m (approx.)');
    expect(announceDistance(2.4149)).toBe('Distance about 2.41 metres, approximate');
  });

  it('tap = < 8 px and < 300 ms', () => {
    expect(isTap(3, 4, 200)).toBe(true);
    expect(isTap(9, 0, 100)).toBe(false);
    expect(isTap(0, 0, 350)).toBe(false);
  });
});
