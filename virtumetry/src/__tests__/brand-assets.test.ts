import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../..');
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;

function ihdr(rel: string) {
  const b = fs.readFileSync(path.join(root, rel));
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

describe('brand config (app.json)', () => {
  it('is dark and uses the root PNG icon on iOS', () => {
    expect(app.userInterfaceStyle).toBe('dark');
    expect(app.icon).toBe('./assets/images/icon.png');
    expect(app.ios).not.toHaveProperty('icon');
  });

  it('adaptive icon uses a solid brand background', () => {
    expect(app.android.adaptiveIcon.backgroundColor).toBe('#060a0a');
    expect(app.android.adaptiveIcon).not.toHaveProperty('backgroundImage');
  });

  it('splash is the brand mark on bg', () => {
    const splash = app.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-splash-screen');
    expect(splash[1]).toMatchObject({
      backgroundColor: '#060a0a',
      image: './assets/images/splash-icon.png',
      imageWidth: 96,
    });
  });

  it('web has a favicon', () => {
    expect(app.web.favicon).toBe('./assets/images/favicon.png');
  });
});

describe('brand PNGs', () => {
  it('icon is 1024 square, opaque RGB', () => {
    expect(ihdr('assets/images/icon.png')).toEqual({ width: 1024, height: 1024, colorType: 2 });
  });

  it('favicon is 64 square', () => {
    expect(ihdr('assets/images/favicon.png')).toMatchObject({ width: 64, height: 64 });
  });

  it.each(['library', 'settings'])('tab icon %s is rendered at 1x/2x/3x (25 pt template)', (name) => {
    [1, 2, 3].forEach((s) =>
      expect(ihdr(`assets/images/tabIcons/${name}${s > 1 ? `@${s}x` : ''}.png`)).toEqual({ width: 25 * s, height: 25 * s, colorType: 6 }),
    );
  });
});

describe('starter leftovers', () => {
  it.each([
    'scripts/reset-project.js',
    'assets/expo.icon',
    'assets/images/android-icon-background.png',
    'assets/images/expo-badge.png',
    'assets/images/expo-badge-white.png',
    'assets/images/expo-logo.png',
    'assets/images/logo-glow.png',
    'assets/images/react-logo.png',
    'assets/images/react-logo@2x.png',
    'assets/images/react-logo@3x.png',
    'assets/images/tutorial-web.png',
    'assets/images/tabIcons/home.png',
    'assets/images/tabIcons/explore.png',
  ])('%s is gone', (rel) => {
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
  });
});
