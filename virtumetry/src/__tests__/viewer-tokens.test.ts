import { tokens } from '@/design/tokens';
import { VT } from '@/viewer/tokens';

it('VT is the single token module (D-02)', () => {
  expect(VT).toBe(tokens);
});
