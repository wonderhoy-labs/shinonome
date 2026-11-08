package com.wonderhoylabs.shinonome.server;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;

/** The pairing code and owner-only file storage for secrets. */
final class Secrets {

	// Crockford base32: no I, L, O or U, so a code survives being read aloud or retyped.
	private static final String ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	private static final int CODE_LENGTH = 10;

	private Secrets() {
	}

	static String loadOrCreatePairingCode(File dir) throws IOException {
		File file = new File(dir, "pairing-code");
		if (file.exists()) {
			return new String(Files.readAllBytes(file.toPath()), StandardCharsets.US_ASCII).trim();
		}
		SecureRandom random = new SecureRandom();
		StringBuilder code = new StringBuilder(CODE_LENGTH);
		for (int i = 0; i < CODE_LENGTH; i++) {
			code.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
		}
		write(file, code.toString().getBytes(StandardCharsets.US_ASCII));
		return code.toString();
	}

	static void write(File file, byte[] data) throws IOException {
		// Restrict the empty file first, so the secret is never readable by others.
		if (!file.exists() && !file.createNewFile()) {
			throw new IOException("Could not create " + file);
		}
		file.setReadable(false, false);
		file.setWritable(false, false);
		file.setReadable(true, true);
		file.setWritable(true, true);
		try (FileOutputStream out = new FileOutputStream(file)) {
			out.write(data);
		}
	}
}
