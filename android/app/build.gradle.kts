// SpazaStock for Android: a Trusted Web Activity that opens https://spazastock.kasalatechnologies.co.za
// full screen in Chrome. The app itself holds no web code; updates ship with every website deploy.

plugins {
    id("com.android.application")
}

// The live site the app opens. Must match public/.well-known/assetlinks.json on that host.
val siteHost = "spazastock.kasalatechnologies.co.za"

android {
    namespace = "za.co.kasalatechnologies.spazastock"
    compileSdk = 36

    defaultConfig {
        applicationId = "za.co.kasalatechnologies.spazastock"
        minSdk = 21
        targetSdk = 36
        // CI passes the run number so every upload to Play has a higher version code.
        versionCode = (System.getenv("ANDROID_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("ANDROID_VERSION_NAME") ?: "1.0.0"

        resValue("string", "appName", "SpazaStock")
        resValue("string", "launcherName", "SpazaStock")
        resValue("string", "launchUrl", "https://$siteHost/")
        resValue("string", "webManifestUrl", "https://$siteHost/manifest.webmanifest")
        resValue("string", "providerAuthority", "za.co.kasalatechnologies.spazastock.fileprovider")
        resValue(
            "string",
            "assetStatements",
            """[{ "relation": ["delegate_permission/common.handle_all_urls"], "target": { "namespace": "web", "site": "https://$siteHost" } }]"""
        )
        manifestPlaceholders["siteHost"] = siteHost
    }

    // Upload key from CI secrets (see android/README.md). Without it, only debug builds are made.
    val keystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
    signingConfigs {
        if (keystorePath != null) {
            create("upload") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePath != null) signingConfig = signingConfigs.getByName("upload")
        }
    }

    buildFeatures {
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
}
