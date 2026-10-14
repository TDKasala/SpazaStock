/** Invite links look like `https://app.example/?invite=<64 hex characters>`. */

export const INVITE_PARAM = 'invite';
const PENDING_KEY = 'spazastock_pending_invite';

export function isInviteToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function parseInviteToken(search: string): string | null {
  const token = new URLSearchParams(search).get(INVITE_PARAM)?.trim().toLowerCase() ?? null;
  return isInviteToken(token) ? token : null;
}

export function buildInviteLink(origin: string, token: string): string {
  const url = new URL('/', origin);
  url.searchParams.set(INVITE_PARAM, token);
  return url.toString();
}

export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/**
 * Moves an invite token from the address bar into session storage, so it survives signing up and
 * confirming the email but does not linger in the browser history. Returns the pending token.
 */
export function captureInviteFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (params.has(INVITE_PARAM)) {
    const token = parseInviteToken(window.location.search);
    params.delete(INVITE_PARAM);
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    try {
      if (token) sessionStorage.setItem(PENDING_KEY, token);
    } catch {
      return token;
    }
  }
  return readPendingInvite();
}

export function readPendingInvite(): string | null {
  try {
    const token = sessionStorage.getItem(PENDING_KEY);
    return isInviteToken(token) ? token : null;
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing stored.
  }
}
