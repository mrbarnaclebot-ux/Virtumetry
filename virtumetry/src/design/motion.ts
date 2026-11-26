// UI-SPEC §1.5 / §11. Reanimated's reduced-motion hook only reads the launch value; this one is live.
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { Easing } from 'react-native-reanimated';

import { motion } from './tokens';

export function useReduceMotion() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => live && setOn(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return on;
}

export const ease = {
  outQuart: Easing.bezier(...motion.easing.outQuart),
  outExpo: Easing.bezier(...motion.easing.outExpo),
  inQuart: Easing.bezier(...motion.easing.inQuart),
};
