import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Research Pitfall 3: the Railway image must ship the mock provider's outputs,
// or a dev scan never reaches 'ready'.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (f: string) => readFileSync(`${ROOT}${f}`, 'utf8');

describe('Docker image ships mock outputs', () => {
  it('Dockerfile copies them to /app/test/fixtures/mock-outputs', () => {
    expect(read('Dockerfile')).toMatch(
      /^COPY --chown=node:node backend\/test\/fixtures\/mock-outputs \.\/test\/fixtures\/mock-outputs$/m,
    );
  });

  it('.dockerignore re-includes them after excluding backend/test', () => {
    const lines = read('.dockerignore').split(/\r?\n/);
    const exclude = lines.indexOf('backend/test');
    const include = lines.indexOf('!backend/test/fixtures/mock-outputs');
    expect(exclude).toBeGreaterThanOrEqual(0);
    expect(include).toBeGreaterThan(exclude);
  });

  it('every output mock.ts serves exists', () => {
    for (const name of ['splat.ply', 'collider.ply', 'floorplan.png', 'floorplan.json', 'cameras.json']) {
      expect(existsSync(`${ROOT}backend/test/fixtures/mock-outputs/${name}`), name).toBe(true);
    }
  });
});
