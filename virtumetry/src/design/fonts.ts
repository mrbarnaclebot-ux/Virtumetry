// UI-SPEC §3: the three custom faces. Per-weight subpaths: the package roots require every TTF.
import { MartianMono_500Medium } from '@expo-google-fonts/martian-mono/500Medium';
import { SchibstedGrotesk_600SemiBold } from '@expo-google-fonts/schibsted-grotesk/600SemiBold';
import { SchibstedGrotesk_700Bold } from '@expo-google-fonts/schibsted-grotesk/700Bold';
import { FontDisplay } from 'expo-font';

// display is web-only (no render blocking on the share page); ignored on native.
const swap = (uri: number) => ({ uri, display: FontDisplay.SWAP });

export const FONT_MAP = {
  SchibstedGrotesk_600SemiBold: swap(SchibstedGrotesk_600SemiBold),
  SchibstedGrotesk_700Bold: swap(SchibstedGrotesk_700Bold),
  MartianMono_500Medium: swap(MartianMono_500Medium),
};
