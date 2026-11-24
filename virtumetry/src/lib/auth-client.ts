import { expoClient } from '@better-auth/expo/client';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';

import { API_URL } from '@/config/api';

// Session cookie lives in the keychain under virtumetry_cookie / virtumetry_session_data (D-08).
export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [expoClient({ scheme: 'virtumetry', storagePrefix: 'virtumetry', storage: SecureStore })],
});
