import { signOut } from '@/auth';

/**
 * Ends a web session whose user can no longer get access tokens (password reset, deactivation);
 * the home page redirects here. A GET logout is only a nuisance risk: the session cookie is
 * SameSite=Strict, so other sites cannot trigger it. `signOut` redirects to /login.
 */
export async function GET(): Promise<never> {
  await signOut({ redirectTo: '/login' });
  throw new Error('unreachable: signOut redirects');
}
