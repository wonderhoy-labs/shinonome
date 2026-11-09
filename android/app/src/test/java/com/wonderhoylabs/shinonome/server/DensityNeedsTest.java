package com.wonderhoylabs.shinonome.server;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class DensityNeedsTest {
	@Rule
	public final TemporaryFolder folder = new TemporaryFolder();

	private File apk(String... entries) throws IOException {
		File file = folder.newFile();
		try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(file))) {
			for (String entry : entries) {
				zip.putNextEntry(new ZipEntry(entry));
				zip.write(1);
				zip.closeEntry();
			}
		}
		return file;
	}

	@Test
	public void findsReactNativeInAnyAbi() throws IOException {
		// Discord's split APK, as of 352.17.
		assertTrue(DensityNeeds.containsReactNative(apk("lib/arm64-v8a/libfbjni.so", "lib/arm64-v8a/libreactnative.so")));
		assertTrue(DensityNeeds.containsReactNative(apk("lib/x86_64/libreactnative.so")));
		// Older React Native.
		assertTrue(DensityNeeds.containsReactNative(apk("lib/armeabi-v7a/libreactnativejni.so")));
	}

	@Test
	public void leavesOtherAppsAlone() throws IOException {
		assertFalse(DensityNeeds.containsReactNative(apk("classes.dex", "lib/arm64-v8a/libflutter.so")));
		// Only libraries count, not a file that happens to have the name.
		assertFalse(DensityNeeds.containsReactNative(apk("assets/libreactnative.so")));
		assertFalse(DensityNeeds.containsReactNative(apk("lib/arm64-v8a/libnotreactnative.so")));
	}

	@Test
	public void unreadableApksDontCount() throws IOException {
		assertFalse(DensityNeeds.containsReactNative(new File(folder.getRoot(), "missing.apk")));
		File notZip = folder.newFile();
		java.nio.file.Files.writeString(notZip.toPath(), "not a zip");
		assertFalse(DensityNeeds.containsReactNative(notZip));
	}

	@Test
	public void escapesJsonStrings() {
		assertEquals("null", Server.jsonString(null));
		assertEquals("\"Discord\"", Server.jsonString("Discord"));
		assertEquals("\"a \\\"b\\\" \\\\ c\\u000a\"", Server.jsonString("a \"b\" \\ c\n"));
	}
}
