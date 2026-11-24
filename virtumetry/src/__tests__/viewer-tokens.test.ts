import { Colors } from '@/constants/theme';
import { VT } from '@/viewer/tokens';

const lower = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toLowerCase()]));

it('viewer tokens copy Colors.dark exactly (UI-SPEC)', () => {
  const d = Colors.dark;
  expect(lower({
    bg: VT.bg,
    surface: VT.surface,
    surfaceSelected: VT.surfaceSelected,
    text: VT.text,
    textSecondary: VT.textSecondary,
    accent: VT.accent,
    onAccent: VT.onAccent,
    destructive: VT.destructive,
    warning: VT.warning,
  })).toEqual(lower({
    bg: d.background,
    surface: d.backgroundElement,
    surfaceSelected: d.backgroundSelected,
    text: d.text,
    textSecondary: d.textSecondary,
    accent: d.accent,
    onAccent: d.onAccent,
    destructive: d.destructive,
    warning: d.warning,
  }));
});
