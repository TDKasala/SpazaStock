import React, { useEffect, useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { ErrorMessage } from '../ui/ErrorMessage';
import { takeIdleSignOutNotice } from '../../lib/idleSignOut';
import { loginInitialView, takeSignInScreenRequest } from '../../lib/signInRedirect';
import { takeSuspendedSignInNotice } from '../../lib/suspendedSignIn';
import { AuthLayout } from './AuthLayout';
import { SignInPanel } from './SignInScreen';

/** Sign-in, registration, and password reset on their own page, separate from the overview. */
export const LoginPage: React.FC = () => {
  const { t } = useLanguage();
  const [idleNotice] = useState(takeIdleSignOutNotice);
  const [shopSuspended] = useState(takeSuspendedSignInNotice);
  const [initialView] = useState(() => loginInitialView(window.location.search));
  useEffect(() => {
    takeSignInScreenRequest();
  }, []);

  return (
    <SignInPanel
      initialView={initialView}
      frame={({ title, subtitle, children }) => (
        <AuthLayout
          title={title}
          subtitle={subtitle}
          banner={
            idleNotice || shopSuspended ? (
              <div className="space-y-3">
                {idleNotice && <ErrorMessage variant="info" message={t('auth.idleSignedOut')} />}
                {shopSuspended && <ErrorMessage variant="error" message={t('auth.shopSuspended')} />}
              </div>
            ) : undefined
          }
        >
          {children}
        </AuthLayout>
      )}
    />
  );
};
