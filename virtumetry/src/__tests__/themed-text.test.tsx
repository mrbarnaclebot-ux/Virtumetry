import { render, renderHook, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors } from '@/constants/theme';
import { color } from '@/design/tokens';
import { useTheme } from '@/hooks/use-theme';

async function textOf(el: React.ReactElement) {
  await render(el);
  const node = screen.getByText('x');
  return { style: StyleSheet.flatten(node.props.style), cap: node.props.maxFontSizeMultiplier };
}

it('title uses the display face, no fontWeight, cap 1.3', async () => {
  const { style, cap } = await textOf(<ThemedText type="title">x</ThemedText>);
  expect(style.fontFamily).toBe('SchibstedGrotesk_700Bold');
  expect(style.fontSize).toBe(28);
  expect(style.fontWeight).toBeUndefined();
  expect(cap).toBe(1.3);
});

it.each(['body', 'default'] as const)('%s renders body 17 / 400 / cap 1.6', async (type) => {
  const { style, cap } = await textOf(<ThemedText type={type}>x</ThemedText>);
  expect(style.fontSize).toBe(17);
  expect(style.fontWeight).toBe('400');
  expect(cap).toBe(1.6);
});

it('eyebrow is uppercase with cap 1.2', async () => {
  const { style, cap } = await textOf(<ThemedText type="eyebrow">x</ThemedText>);
  expect(style.textTransform).toBe('uppercase');
  expect(cap).toBe(1.2);
});

it('hudStatus is system 22 / 28 / 600, cap 1.3', async () => {
  const { style, cap } = await textOf(<ThemedText type="hudStatus">x</ThemedText>);
  expect(style).toMatchObject({ fontSize: 22, lineHeight: 28, fontWeight: '600' });
  expect(style.fontFamily).toBeUndefined();
  expect(cap).toBe(1.3);
});

it('explicit maxFontSizeMultiplier overrides the role cap', async () => {
  const { cap } = await textOf(<ThemedText maxFontSizeMultiplier={1.3}>x</ThemedText>);
  expect(cap).toBe(1.3);
});

it('tone and legacy themeColor set the colour', async () => {
  expect((await textOf(<ThemedText tone="danger">x</ThemedText>)).style.color).toBe(color.danger);
  expect((await textOf(<ThemedText themeColor="textSecondary">x</ThemedText>)).style.color).toBe(color.textMuted);
});

it('useTheme returns Colors and background is the bg token', async () => {
  const { result } = await renderHook(() => useTheme());
  expect(result.current).toBe(Colors);
  expect(Colors.background).toBe(color.bg);
});
