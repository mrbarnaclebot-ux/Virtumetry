import { DEFAULT_CAPTURE_CONFIG, type Pricing } from './capture-config';

export type Cost = { credits: number; usd: number };

/** D-09: credits = base + perFrame x frames; usd rounded to cents. */
export function costFor(frames: number, pricing: Pricing = DEFAULT_CAPTURE_CONFIG.pricing): Cost {
  const credits = pricing.baseCredits + pricing.perFrameCredits * frames;
  return { credits, usd: Math.round(credits * pricing.usdPerCredit * 100) / 100 };
}

export const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;
export const formatCredits = (credits: number) => `${credits.toLocaleString('en-US')} credits`;
export const formatCost = (c: Cost) => `${formatUsd(c.usd)} · ${formatCredits(c.credits)}`;
