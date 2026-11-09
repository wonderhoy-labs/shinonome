plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.plugin.compose")
}

// VERSION at the top of the repository is shared with the web app, which offers the phone this version.
val appVersion = rootProject.file("../VERSION").readText().trim()
val appVersionCode =
	appVersion.split(".").map(String::toInt).let { (major, minor, patch) ->
		major * 10_000 + minor * 100 + patch
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
		versionCode = appVersionCode
		versionName = appVersion
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
			// Shrunk, because the sites and the library carry this APK. proguard-rules.pro keeps what's started by name.
			isMinifyEnabled = true
			isShrinkResources = true
			proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
		compose = true
	}
}

dependencies {
	implementation(platform("androidx.compose:compose-bom:2026.09.00"))
	implementation("androidx.activity:activity-compose:1.13.0")
	implementation("androidx.compose.foundation:foundation")
	implementation("androidx.compose.material3:material3")
	implementation("androidx.compose.ui:ui")
	implementation("dev.rikka.shizuku:api:13.1.5")
	implementation("dev.rikka.shizuku:provider:13.1.5")

	testImplementation("junit:junit:4.13.2")
}
