import { router, useLocalSearchParams } from 'expo-router';

import { OnboardingPager, type OnboardingPage } from '@/components/onboarding/pager';
import { useLocalScans } from '@/capture/store';
import { markOnboarded } from '@/design/first-run';
import { useWorlds } from '@/lib/api';

// UI-SPEC §8.1 copy table.
const PAGES: OnboardingPage[] = [
  {
    headline: 'Walk the room',
    body: 'Hold your phone at chest height and walk slowly around the room. The scan screen tells you when you have enough.',
  },
  {
    headline: 'Check before you pay',
    body: 'Before anything uploads, the app checks the scan and shows the cost. Nothing is charged until you approve.',
  },
  {
    headline: 'We build it',
    body: 'Your room is processed in the cloud. It usually takes 30 minutes to 2 hours, and your Library shows the progress.',
  },
  {
    headline: 'Walk, measure, share',
    body: 'Walk through the room, measure between any two points, and share a link that opens in any browser.',
  },
];

export default function OnboardingScreen() {
  const replay = useLocalSearchParams<{ replay?: string }>().replay === '1';
  const worlds = useWorlds();
  const { scans } = useLocalScans();
  // Pending or failed worlds query → not known to be empty → "Go to library".
  const empty = worlds.data?.worlds.length === 0 && scans.length === 0;

  // The flag flip does not navigate (RESEARCH Pattern 5): replace to the Library explicitly.
  const finish = (intent?: 'scan') => {
    markOnboarded(intent);
    router.replace('/');
  };

  if (replay) return <OnboardingPager replay pages={PAGES} ctaLabel="Done" onFinish={() => router.back()} onSkip={() => router.back()} />;

  return (
    <OnboardingPager
      pages={PAGES}
      ctaLabel={empty ? 'Scan your first room' : 'Go to library'}
      onFinish={() => finish(empty ? 'scan' : undefined)}
      onSkip={() => finish()}
    />
  );
}
