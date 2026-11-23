import { describe, it, expect } from 'vitest';
import { evaluateQuota } from '../src/quota.js';
import { backoffSeconds } from '../src/queue.js';

const now = new Date('2026-07-12T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('evaluateQuota', () => {
  it('opens a fresh window on first scan (no reset time)', () => {
    const d = evaluateQuota({ dailyScanCount: 0, quotaResetAt: null }, 10, now);
    expect(d.allowed).toBe(true);
    expect(d.newCount).toBe(1);
    expect(d.newResetAt.getTime()).toBe(now.getTime() + DAY);
  });

  it('resets when the window has expired', () => {
    const past = new Date(now.getTime() - 1000);
    const d = evaluateQuota({ dailyScanCount: 10, quotaResetAt: past }, 10, now);
    expect(d.allowed).toBe(true);
    expect(d.newCount).toBe(1);
    expect(d.newResetAt.getTime()).toBe(now.getTime() + DAY);
  });

  it('increments within an active window', () => {
    const future = new Date(now.getTime() + DAY / 2);
    const d = evaluateQuota({ dailyScanCount: 3, quotaResetAt: future }, 10, now);
    expect(d.allowed).toBe(true);
    expect(d.newCount).toBe(4);
    expect(d.newResetAt).toBe(future);
  });

  it('denies once the cap is reached', () => {
    const future = new Date(now.getTime() + DAY / 2);
    const d = evaluateQuota({ dailyScanCount: 10, quotaResetAt: future }, 10, now);
    expect(d.allowed).toBe(false);
    expect(d.retryAt).toBe(future);
  });
});

describe('backoffSeconds', () => {
  it('grows exponentially from 30s', () => {
    expect(backoffSeconds(0)).toBe(30);
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(120);
  });

  it('caps at one hour', () => {
    expect(backoffSeconds(20)).toBe(3600);
  });
});
