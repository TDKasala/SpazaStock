import { describe, it, expect, beforeEach } from 'vitest';
import { clearFreshSignIn, hasFreshSignIn, markFreshSignIn, postSignInDestination } from '../lib/platformAdmin';

describe('redirect after signing in', () => {
  beforeEach(() => clearFreshSignIn());

  it('only counts a sign-in made in this tab', () => {
    expect(hasFreshSignIn()).toBe(false);
    markFreshSignIn();
    expect(hasFreshSignIn()).toBe(true);
    clearFreshSignIn();
    expect(hasFreshSignIn()).toBe(false);
  });

  it('sends platform admins to the console once', async () => {
    markFreshSignIn();
    expect(await postSignInDestination(async () => 'superadmin')).toBe('/admin');
    expect(hasFreshSignIn()).toBe(false);
  });

  it('keeps shop users, and admins the server cannot confirm, in the shop app', async () => {
    markFreshSignIn();
    expect(await postSignInDestination(async () => null)).toBeNull();
    expect(hasFreshSignIn()).toBe(false);
  });

  it('keeps the flag until the server has answered', async () => {
    markFreshSignIn();
    let answer: (role: string | null) => void = () => {};
    const pending = postSignInDestination(() => new Promise((resolve) => (answer = resolve)));
    expect(hasFreshSignIn()).toBe(true);
    answer('support');
    expect(await pending).toBe('/admin');
    expect(hasFreshSignIn()).toBe(false);
  });
});
