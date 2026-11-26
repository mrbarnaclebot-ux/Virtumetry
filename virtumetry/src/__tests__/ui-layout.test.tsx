import { fireEvent, render, screen } from '@testing-library/react-native';
import { SymbolView } from 'expo-symbols';
import { StyleSheet } from 'react-native';

import { ListRow } from '@/components/ui/list-row';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SheetHeader } from '@/components/ui/sheet-header';
import { StatusPill } from '@/components/ui/status-pill';
import { TextField } from '@/components/ui/text-field';
import { haptic } from '@/design/haptics';
import { color } from '@/design/tokens';

jest.mock('expo-symbols', () => ({ SymbolView: jest.fn(() => null) }));

const lastSymbol = () => jest.mocked(SymbolView).mock.calls.at(-1)![0] as { name: { ios: string }; tintColor: string };

afterEach(() => jest.restoreAllMocks());

describe('ListRow', () => {
  it('with onPress: a button named by title and subtitle', async () => {
    const onPress = jest.fn();
    await render(<ListRow title="Replay intro" subtitle="See the four steps again" onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Replay intro, See the four steps again' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('without onPress: plain text, no role', async () => {
    await render(<ListRow title="Signed in as" subtitle="me@example.com" />);
    expect(screen.getByText('Signed in as')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('StatusPill', () => {
  it.each([
    ['ready', 'checkmark.circle.fill', color.success],
    ['failed', 'exclamationmark.triangle.fill', color.danger],
    ['paused', 'wifi.slash', color.textMuted],
  ] as const)('%s → %s', async (kind, sf, tint) => {
    await render(<StatusPill kind={kind} label="Status word" />);
    expect(lastSymbol().name.ios).toBe(sf);
    expect(lastSymbol().tintColor).toBe(tint);
    expect(screen.getByText('Status word')).toBeTruthy();
  });
});

describe('TextField', () => {
  it('forwards props, is labelled, and shows the error with a danger border', async () => {
    const onChangeText = jest.fn();
    await render(<TextField label="Password" secureTextEntry onChangeText={onChangeText} error="Wrong password" />);
    const input = screen.getByLabelText('Password');
    expect(input.props.secureTextEntry).toBe(true);
    await fireEvent.changeText(input, 'hunter2');
    expect(onChangeText).toHaveBeenCalledWith('hunter2');
    expect(screen.getByText('Wrong password')).toBeTruthy();
    const style = StyleSheet.flatten(input.props.style);
    expect(style.borderColor).toBe(color.danger);
    expect(style.borderWidth).toBe(2);
  });

  it('focus thickens the border to primary', async () => {
    await render(<TextField label="Email" />);
    const input = screen.getByLabelText('Email');
    await fireEvent(input, 'focus');
    const style = StyleSheet.flatten(screen.getByLabelText('Email').props.style);
    expect(style).toMatchObject({ borderColor: color.primary, borderWidth: 2 });
  });
});

describe('SegmentedControl', () => {
  const options = [
    { id: 'good', label: 'Good' },
    { id: 'dark', label: 'Too dark' },
    { id: 'blur', label: 'Blurry' },
  ] as const;

  it('radios; change fires onChange + selection haptic; disabled explains instead', async () => {
    const selection = jest.spyOn(haptic, 'selection');
    const onChange = jest.fn();
    const onDisabledPress = jest.fn();
    await render(
      <SegmentedControl options={options} value="good" onChange={onChange} disabled={['blur']} onDisabledPress={onDisabledPress} />,
    );
    expect(screen.getByRole('radio', { name: 'Good' }).props.accessibilityState).toMatchObject({ selected: true });

    await fireEvent.press(screen.getByRole('radio', { name: 'Too dark' }));
    expect(onChange).toHaveBeenCalledWith('dark');
    expect(selection).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole('radio', { name: 'Blurry' }));
    expect(onDisabledPress).toHaveBeenCalledWith('blur');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('optionRole="button" keeps button roles with custom labels', async () => {
    await render(
      <SegmentedControl
        options={options}
        value="good"
        onChange={jest.fn()}
        optionRole="button"
        accessibilityLabelFor={(o) => `${o.label} scenario`}
      />,
    );
    expect(screen.getByRole('button', { name: 'Too dark scenario' })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('SheetHeader', () => {
  it('title is a header; trailing button calls onPress', async () => {
    const onPress = jest.fn();
    await render(<SheetHeader title="Share" trailing={{ label: 'Done', onPress }} />);
    expect(screen.getByRole('header', { name: 'Share' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
