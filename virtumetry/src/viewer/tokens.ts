/** Viewer tokens (UI-SPEC). No imports: the DOM component must not pull constants/theme (react-native + global.css). */
export const VT = {
  bg: '#000000', // = Colors.dark.background
  surface: '#212225', // = Colors.dark.backgroundElement
  surfaceSelected: '#2E3135', // = Colors.dark.backgroundSelected
  text: '#FFFFFF', // = Colors.dark.text
  textSecondary: '#B0B4BA', // = Colors.dark.textSecondary
  accent: '#3CC8B4', // = Colors.dark.accent
  onAccent: '#000000', // = Colors.dark.onAccent
  destructive: '#FF6B5E', // = Colors.dark.destructive
  warning: '#F5A524', // = Colors.dark.warning
  scrim: 'rgba(0,0,0,0.6)', // Phase 4 HUD scrim
  ghost: 'rgba(255,255,255,0.15)', // joystick base fill
  ghostStroke: 'rgba(255,255,255,0.3)',
  knob: 'rgba(255,255,255,0.6)',
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 64 }, // = Spacing.one..six
  radius: { sm: 8, md: 12, lg: 16, pill: 22 },
  font: { label: 14, body: 16, heading: 20, display: 32 },
  weight: { regular: 400, semibold: 600 },
} as const;
