const OPEN_SIGN_IN_KEY = 'spazastock_open_sign_in';

/** Asks the next page load to open the sign-in form. */
export function requestSignInScreen(): void {
  try {
    sessionStorage.setItem(OPEN_SIGN_IN_KEY, '1');
  } catch {
    // Private browsing without storage: the redirect still lands on the public page.
  }
}

/** Reads the sign-in request once, then clears it so a refresh shows the overview again. */
export function takeSignInScreenRequest(): boolean {
  try {
    if (sessionStorage.getItem(OPEN_SIGN_IN_KEY) !== '1') return false;
    sessionStorage.removeItem(OPEN_SIGN_IN_KEY);
    return true;
  } catch {
    return false;
  }
}
