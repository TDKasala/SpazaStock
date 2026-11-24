package za.co.kasalatechnologies.spazastock;

import com.google.androidbrowserhelper.trusted.NotificationPermissionRequestHandler;

/**
 * Lets the site's Web Push notifications appear as SpazaStock app notifications, and lets the
 * site ask for Android 13+'s notification permission.
 */
public class DelegationService extends com.google.androidbrowserhelper.trusted.DelegationService {
    @Override
    public void onCreate() {
        super.onCreate();
        registerExtraCommandHandler(new NotificationPermissionRequestHandler());
    }
}
