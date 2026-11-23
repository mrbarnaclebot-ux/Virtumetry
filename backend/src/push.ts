// APNs push — STUB (spec §4 "APNs world ready"). Real Apple Push Notification
// delivery (token auth, device lookup, HTTP/2) is a later phase. For now this
// logs in dev so the worker's notify-on-complete path is exercised end to end.

export type SendPush = (
  userId: string,
  title: string,
  body: string,
) => Promise<void>;

export const sendPush: SendPush = async (userId, title, body) => {
  // eslint-disable-next-line no-console
  console.log(`[push:stub] → user=${userId} "${title}" — ${body}`);
};
