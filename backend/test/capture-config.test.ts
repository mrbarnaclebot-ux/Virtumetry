import { describe, it, expect } from 'vitest';
import { captureConfig, DEFAULT_CAPTURE_CONFIG, PRICING } from '../src/capture-config.js';
import { loadConfig } from '../src/config.js';

const DEV =
  '{"readiness":{"minFramesGreen":25,"minFramesAmber":15,"minSectorsGreen":1,"minSectorsAmber":1},"precheck":{"minFrames":20,"minCoverageSectors":1}}';
const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', DEV_AUTH_TOKEN: 'dev-token' };

describe('captureConfig', () => {
  it('no env value → the code defaults', () => {
    expect(captureConfig({ CAPTURE_CONFIG_JSON: undefined })).toEqual(DEFAULT_CAPTURE_CONFIG);
  });

  it('pins the production defaults', () => {
    expect(DEFAULT_CAPTURE_CONFIG).toEqual({
      readiness: {
        minFramesGreen: 150,
        minFramesAmber: 80,
        minSectorsGreen: 9,
        minSectorsAmber: 6,
        maxBlurShareGreen: 0.1,
        maxBlurShareAmber: 0.2,
        maxTrackingGapShareGreen: 0.0,
        maxTrackingGapShareAmber: 0.05,
      },
      precheck: { minFrames: 50, maxBlurShare: 0.25, maxTrackingGapShare: 0.0, minCoverageSectors: 4 },
    });
  });

  it('pins pricing', () => {
    expect(PRICING).toEqual({ baseCredits: 900, perFrameCredits: 1, usdPerCredit: 0.01 });
  });

  it('dev JSON merges over the defaults per section', () => {
    const cc = captureConfig({ CAPTURE_CONFIG_JSON: DEV });
    expect(cc.readiness.minFramesGreen).toBe(25);
    expect(cc.readiness.maxBlurShareGreen).toBe(0.1);
    expect(cc.precheck.minFrames).toBe(20);
    expect(cc.precheck.maxBlurShare).toBe(0.25);
    expect(cc.precheck.minCoverageSectors).toBe(1);
  });

  it('loadConfig accepts the dev JSON', () => {
    expect(() => loadConfig({ ...base, CAPTURE_CONFIG_JSON: DEV } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it.each([
    ['unknown key', '{"precheck":{"bogus":1}}'],
    ['unknown section', '{"secretsection":{}}'],
    ['wrong type', '{"precheck":{"minFrames":"many"}}'],
    ['share out of range', '{"precheck":{"maxBlurShare":7}}'],
    ['invalid JSON', '{not-json-SECRETVALUE'],
  ])('%s → boot fails naming the variable, never the value', (_, bad) => {
    let msg = '';
    try {
      loadConfig({ ...base, CAPTURE_CONFIG_JSON: bad } as NodeJS.ProcessEnv);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('CAPTURE_CONFIG_JSON is invalid');
    expect(msg).not.toContain(bad);
    expect(msg).not.toMatch(/bogus|secretsection|many|SECRETVALUE/);
  });
});
