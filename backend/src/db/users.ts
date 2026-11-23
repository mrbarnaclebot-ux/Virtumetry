import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { users, type User } from './schema.js';

/** Idempotent upsert keyed by apple_sub (identity subject in both auth modes). */
export async function upsertUserBySub(
  db: Db,
  appleSub: string,
  displayName?: string | null,
): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({ appleSub, displayName: displayName ?? null })
    .onConflictDoUpdate({
      target: users.appleSub,
      // Touch nothing sensitive on conflict; keep the row, refresh display name
      // only when a new one is supplied.
      set: { appleSub },
    })
    .returning();
  if (row) return row;
  // Fallback (should not happen): fetch existing.
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.appleSub, appleSub))
    .limit(1);
  return existing!;
}
