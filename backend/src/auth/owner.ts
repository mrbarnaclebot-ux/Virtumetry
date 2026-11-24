import type { Auth } from './better-auth.js';

/**
 * Create, link or reset the owner's email+password credential directly through
 * Better Auth's internal adapter (RESEARCH Pattern 4). auth.api.signUpEmail is
 * unusable here: disableSignUp makes it throw. Never logs email or password.
 */
export async function ensureOwnerCredential(
  auth: Auth,
  rawEmail: string,
  password: string,
): Promise<'created' | 'linked' | 'reset'> {
  const ctx = await auth.$context;
  const email = rawEmail.trim().toLowerCase();
  const hash = await ctx.password.hash(password);
  const found = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });
  if (!found) {
    const u = await ctx.internalAdapter.createUser(
      { email, name: 'Owner', emailVerified: true },
      { method: 'email-password' },
    );
    await ctx.internalAdapter.linkAccount({
      userId: u.id,
      providerId: 'credential',
      accountId: u.id,
      password: hash,
    });
    return 'created';
  }
  if (!found.accounts.some((a) => a.providerId === 'credential')) {
    await ctx.internalAdapter.linkAccount({
      userId: found.user.id,
      providerId: 'credential',
      accountId: found.user.id,
      password: hash,
    });
    return 'linked';
  }
  await ctx.internalAdapter.updatePassword(found.user.id, hash);
  // A reset logs out every existing session (T-03-15: stolen-session recovery).
  await ctx.internalAdapter.deleteUserSessions(found.user.id);
  return 'reset';
}
