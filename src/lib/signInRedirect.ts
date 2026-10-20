const OPEN_SIGN_IN_KEY = 'spazastock_open_sign_in';

export const LOGIN_PATH = '/login';

/** The dedicated sign-in page. `register` opens account creation. */
export function loginHref(view: 'password' | 'register' = 'password'): string {
  return view === 'register' ? `${LOGIN_PATH}?view=register` : LOGIN_PATH;
}

export function isLoginPath(pathname: string): boolean {
  return /^\/login\/?$/.test(pathname);
}

/** Where a signed-out visit should go. Already on the login page means stay put. */
export function loggedOutRedirect(pathname: string): string | null {
  return isLoginPath(pathname) ? null : loginHref();
}

export function loginInitialView(search: string): 'password' | 'register' {
  return new URLSearchParams(search).get('view') === 'register' ? 'register' : 'password';
}

/** Asks the next page load to open the sign-in page. */
export function requestSignInScreen(): void {
  try {
    sessionStorage.setItem(OPEN_SIGN_IN_KEY, '1');
  } catch {
    // Private browsing without storage: the redirect still lands on the public page.
  }
}

/** Reads the sign-in request once, then clears it so a later visit stays on the overview. */
export function takeSignInScreenRequest(): boolean {
  try {
    if (sessionStorage.getItem(OPEN_SIGN_IN_KEY) !== '1') return false;
    sessionStorage.removeItem(OPEN_SIGN_IN_KEY);
    return true;
  } catch {
    return false;
  }
}
