import { costFor, formatCost } from '@/capture/cost';
import { DEFAULT_CAPTURE_CONFIG } from '@/capture/capture-config';

describe('costFor / formatCost (D-09)', () => {
  it('prices 30 frames at 930 credits / $9.30', () => {
    expect(costFor(30, DEFAULT_CAPTURE_CONFIG.pricing)).toEqual({ credits: 930, usd: 9.3 });
    expect(formatCost(costFor(30))).toBe('$9.30 · 930 credits');
  });

  it('shows the base cost before the first frame', () => {
    expect(formatCost(costFor(0))).toBe('$9.00 · 900 credits');
  });

  it('groups thousands', () => {
    expect(costFor(440).credits).toBe(1340);
    expect(formatCost(costFor(440))).toBe('$13.40 · 1,340 credits');
  });
});
