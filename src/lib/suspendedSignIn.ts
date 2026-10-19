const SUSPENDED_NOTICE_KEY = 'spazastock_suspended_sign_in';

/** Remembers that sign-in was refused because every shop on the account is suspended. */
export function markSuspendedSignInDenied(): void {
  try {
    sessionStorage.setItem(SUSPENDED_NOTICE_KEY, '1');
  } catch {
    // Private browsing without storage: the notice only lives until the next navigation.
  }
}

/** Reads the suspended-shop notice once, then clears it so a refresh does not show it again. */
export function takeSuspendedSignInNotice(): boolean {
  try {
    if (sessionStorage.getItem(SUSPENDED_NOTICE_KEY) !== '1') return false;
    sessionStorage.removeItem(SUSPENDED_NOTICE_KEY);
    return true;
  } catch {
    return false;
  }
}
