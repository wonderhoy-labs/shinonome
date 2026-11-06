plugins {
    id("com.android.application")
}

android {
    namespace = "com.wonderhoylabs.shinonome"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.wonderhoylabs.shinonome"
        // Creating the display needs Android 14. The desktop itself needs a far newer build, which
        // the app checks at runtime, so that it can explain the problem instead of failing.
        minSdk = 34
        targetSdk = 37
        versionCode = 2
        versionName = "0.1.1"
    }

    // Set these to sign with your own key. Without them a release APK still installs, because it
    // falls back to the debug key, but Android refuses to update an app across different keys.
    signingConfigs {
        System.getenv("SHINONOME_KEYSTORE")?.let { keystore ->
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("SHINONOME_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SHINONOME_KEY_ALIAS")
                keyPassword = System.getenv("SHINONOME_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // The server is started by class name and leans on reflection, so nothing may be renamed.
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        aidl = true
        buildConfig = false
    }
}

dependencies {
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
}
