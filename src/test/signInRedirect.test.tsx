import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LandingPage } from '../components/auth/LandingPage';
import { LanguageProvider } from '../context/LanguageContext';
import { requestSignInScreen, takeSignInScreenRequest } from '../lib/signInRedirect';
import { markSuspendedSignInDenied } from '../lib/suspendedSignIn';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    signInWithPassword: vi.fn(async () => ({})),
    sendCode: vi.fn(async () => ({})),
    verifyCode: vi.fn(async () => ({})),
    confirmSignUp: vi.fn(async () => ({})),
    resendSignUpCode: vi.fn(async () => ({})),
    signUp: vi.fn(async () => ({})),
    requestPasswordReset: vi.fn(async () => ({})),
    verifyResetCode: vi.fn(async () => ({})),
    updatePassword: vi.fn(async () => ({})),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('sign-in redirect', () => {
  it('remembers a sign-in request once', () => {
    expect(takeSignInScreenRequest()).toBe(false);
    requestSignInScreen();
    expect(takeSignInScreenRequest()).toBe(true);
    expect(takeSignInScreenRequest()).toBe(false);
  });

  it('opens the sign-in form after a sign-out redirect', async () => {
    requestSignInScreen();
    await act(async () => {
      root.render(
        <LanguageProvider>
          <LandingPage />
        </LanguageProvider>
      );
    });
    expect(container.textContent).toContain('Password');
    expect(container.querySelector('input[autocomplete="current-password"]')).toBeTruthy();
  });

  it('shows a message when sign-in was refused because the shop is suspended', async () => {
    markSuspendedSignInDenied();
    requestSignInScreen();
    await act(async () => {
      root.render(
        <LanguageProvider>
          <LandingPage />
        </LanguageProvider>
      );
    });
    expect(container.textContent).toContain('This shop is suspended');
    expect(container.textContent).toContain('You cannot sign in until it is reactivated.');
  });
});
