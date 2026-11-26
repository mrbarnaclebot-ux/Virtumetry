import { fireEvent, render, screen } from '@testing-library/react-native';
import { SymbolView } from 'expo-symbols';

import { BrandMark } from '@/components/ui/brand-mark';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { IconButton } from '@/components/ui/icon-button';
import { haptic } from '@/design/haptics';

// Capture the props Icon passes (the iOS SymbolView reduces `name` to the ios string).
jest.mock('expo-symbols', () => ({ SymbolView: jest.fn(() => null) }));

afterEach(() => jest.restoreAllMocks());

describe('Button', () => {
  it('primary: role, name, one onPress and a light haptic per press', async () => {
    const light = jest.spyOn(haptic, 'light');
    const onPress = jest.fn();
    await render(<Button label="Approve" onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(light).toHaveBeenCalledTimes(1);
  });

  it.each(['ghost', 'secondary', 'destructive'] as const)('%s has no haptic', async (variant) => {
    const light = jest.spyOn(haptic, 'light');
    await render(<Button variant={variant} label="Go" onPress={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Go' }));
    expect(light).not.toHaveBeenCalled();
  });

  it('haptic={false} silences a primary', async () => {
    const light = jest.spyOn(haptic, 'light');
    await render(<Button haptic={false} label="Go" onPress={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Go' }));
    expect(light).not.toHaveBeenCalled();
  });

  it('disabled: state, hint, and no press', async () => {
    const onPress = jest.fn();
    await render(<Button disabled hint="Finish the checks first" label="Approve" onPress={onPress} />);
    const btn = screen.getByRole('button', { name: 'Approve' });
    expect(btn.props.accessibilityState).toMatchObject({ disabled: true });
    expect(btn.props.accessibilityHint).toBe('Finish the checks first');
    await fireEvent.press(btn);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('busy: spinner + busyLabel visible, accessible name stays the label', async () => {
    await render(<Button busy busyLabel="Approving…" label="Approve" onPress={jest.fn()} />);
    const btn = screen.getByRole('button', { name: 'Approve' });
    expect(btn.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    expect(screen.getByTestId('button-busy')).toBeTruthy();
    expect(screen.getByText('Approving…')).toBeTruthy();
  });
});

describe('IconButton', () => {
  it('is a 44x44 labelled button that calls onPress', async () => {
    const onPress = jest.fn();
    await render(<IconButton icon="more" accessibilityLabel="More actions" onPress={onPress} />);
    const btn = screen.getByRole('button', { name: 'More actions' });
    const style = Object.assign({}, ...[btn.props.style].flat(Infinity).filter(Boolean));
    expect(style).toMatchObject({ width: 44, height: 44 });
    await fireEvent.press(btn);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('requires accessibilityLabel at the type level', () => {
    // @ts-expect-error accessibilityLabel is required
    void (<IconButton icon="close" onPress={() => {}} />);
  });
});

describe('Icon', () => {
  it('maps a concept to SF + Material names, medium weight, decorative by default', async () => {
    await render(<Icon name="ready" />);
    const sym = { props: jest.mocked(SymbolView).mock.calls.at(-1)![0] };
    expect(sym.props.name).toEqual({ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' });
    expect(sym.props.weight).toBe('medium');
    expect(sym.props.accessible).toBe(false);
  });
});

describe('BrandMark', () => {
  it('lockup is accessible as "Virtumetry"; the bare mark is not', async () => {
    await render(<BrandMark variant="lockup" />);
    expect(screen.getByLabelText('Virtumetry')).toBeTruthy();
    await render(<BrandMark />);
    expect(screen.queryByLabelText('Virtumetry')).toBeNull();
  });
});
