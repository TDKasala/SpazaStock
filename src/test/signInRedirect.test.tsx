import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LandingPage } from '../components/auth/LandingPage';
import { LoginPage } from '../components/auth/LoginPage';
import { LanguageProvider } from '../context/LanguageContext';
import {
  isLoginPath,
  loggedOutRedirect,
  loginHref,
  loginInitialView,
  requestSignInScreen,
  takeSignInScreenRequest,
} from '../lib/signInRedirect';
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
  window.history.replaceState(null, '', '/');
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

  it('keeps the overview free of the sign-in form and links to the login page', async () => {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <LandingPage />
        </LanguageProvider>
      );
    });
    expect(container.querySelector('input[autocomplete="current-password"]')).toBeNull();
    expect(container.querySelector(`a[href="${loginHref()}"]`)?.textContent).toContain('I already have an account');
    expect(container.querySelector(`a[href="${loginHref('register')}"]`)?.textContent).toContain('Create a free account');
  });

  it('opens the sign-in form on the login page', async () => {
    window.history.replaceState(null, '', loginHref());
    requestSignInScreen();
    await act(async () => {
      root.render(
        <LanguageProvider>
          <LoginPage />
        </LanguageProvider>
      );
    });
    expect(container.textContent).toContain('Password');
    expect(container.querySelector('input[autocomplete="current-password"]')).toBeTruthy();
    expect(container.querySelector('a[href="/"]')).toBeNull();
    expect(takeSignInScreenRequest()).toBe(false);
  });

  it('opens account creation when the login page is asked for it', async () => {
    window.history.replaceState(null, '', loginHref('register'));
    await act(async () => {
      root.render(
        <LanguageProvider>
          <LoginPage />
        </LanguageProvider>
      );
    });
    expect(container.textContent).toContain('Create your account');
    expect(container.querySelector('input[autocomplete="current-password"]')).toBeNull();
  });

  it('shows a message when sign-in was refused because the shop is suspended', async () => {
    markSuspendedSignInDenied();
    await act(async () => {
      root.render(
        <LanguageProvider>
          <LoginPage />
        </LanguageProvider>
      );
    });
    expect(container.textContent).toContain('This shop is suspended');
    expect(container.textContent).toContain('You cannot sign in until it is reactivated.');
  });

  it('recognises the login path and its starting view', () => {
    expect(isLoginPath('/login')).toBe(true);
    expect(isLoginPath('/login/')).toBe(true);
    expect(isLoginPath('/')).toBe(false);
    expect(loggedOutRedirect('/')).toBe('/login');
    expect(loggedOutRedirect('/admin')).toBe('/login');
    expect(loggedOutRedirect('/login')).toBeNull();
    expect(loggedOutRedirect('/login/')).toBeNull();
    expect(loginInitialView('')).toBe('password');
    expect(loginInitialView('?view=register')).toBe('register');
  });
});
