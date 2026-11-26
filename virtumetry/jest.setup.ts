// Public test values so modules that resolve the API URL at import time can load.
process.env.EXPO_PUBLIC_APP_ENV = 'test';
process.env.EXPO_PUBLIC_API_URL = 'https://api.test.invalid';

// In-memory expo-secure-store so the real Better Auth expo client can persist cookies in jest.
// Tests seed/inspect via `require('expo-secure-store').__store` and reset with `__reset()`.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    __reset: () => store.clear(),
    getItem: jest.fn((k: string) => store.get(k) ?? null),
    setItem: jest.fn((k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

// useNetworkState's native mock resolves undefined and throws on unmount; tests override per case.
jest.mock('expo-network', () => ({
  useNetworkState: jest.fn(() => ({ isConnected: true, isInternetReachable: true })),
}));

// useSafeAreaInsets throws without a provider.
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
