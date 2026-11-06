package com.wonderhoylabs.shinonome.server;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLServerSocketFactory;
import javax.net.ssl.X509ExtendedKeyManager;

/**
 * A self-signed TLS identity. Browsers only expose WebCodecs on secure pages, so the server needs
 * TLS even though nothing can vouch for its certificate on a home network.
 *
 * Android has no public API for building a certificate, so the DER is assembled here.
 */
final class Tls {

    private static final long DAY_MS = 24L * 60 * 60 * 1000;
    // Browsers reject longer validity on certificates they are asked to trust.
    private static final int VALID_DAYS = 397;
    private static final int RENEW_BEFORE_DAYS = 7;
    private static final String ALIAS = "shinonome";

    private static final byte[] OID_ECDSA_SHA256 = {0x06, 0x08, 0x2A, (byte) 0x86, 0x48, (byte) 0xCE, 0x3D, 0x04, 0x03, 0x02};
    private static final byte[] OID_COMMON_NAME = {0x06, 0x03, 0x55, 0x04, 0x03};
    private static final byte[] OID_SUBJECT_ALT_NAME = {0x06, 0x03, 0x55, 0x1D, 0x11};

    private final PrivateKey key;
    private final X509Certificate certificate;

    private Tls(PrivateKey key, X509Certificate certificate) {
        this.key = key;
        this.certificate = certificate;
    }

    static Tls loadOrCreate(File dir, List<byte[]> addresses) throws IOException, GeneralSecurityException {
        File keyFile = new File(dir, "tls-key.der");
        File certFile = new File(dir, "tls-cert.der");
        if (keyFile.exists() && certFile.exists()) {
            X509Certificate certificate = parseCertificate(Files.readAllBytes(certFile.toPath()));
            long remaining = certificate.getNotAfter().getTime() - System.currentTimeMillis();
            if (remaining > RENEW_BEFORE_DAYS * DAY_MS) {
                PrivateKey key = KeyFactory.getInstance("EC")
                        .generatePrivate(new PKCS8EncodedKeySpec(Files.readAllBytes(keyFile.toPath())));
                return new Tls(key, certificate);
            }
        }
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        byte[] certificate = createCertificate(pair, addresses);
        Secrets.write(keyFile, pair.getPrivate().getEncoded());
        Secrets.write(certFile, certificate);
        return new Tls(pair.getPrivate(), parseCertificate(certificate));
    }

    SSLServerSocketFactory serverSocketFactory() throws GeneralSecurityException {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(new KeyManager[] {new FixedKeyManager()}, null, new SecureRandom());
        return context.getServerSocketFactory();
    }

    String fingerprint() throws GeneralSecurityException {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < digest.length; i++) {
            if (i > 0) {
                out.append(':');
            }
            out.append(String.format(Locale.ROOT, "%02X", digest[i]));
        }
        return out.toString();
    }

    private static X509Certificate parseCertificate(byte[] der) throws GeneralSecurityException {
        return (X509Certificate) CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(der));
    }

    private static byte[] createCertificate(KeyPair pair, List<byte[]> addresses) throws GeneralSecurityException {
        byte[] algorithm = der(0x30, OID_ECDSA_SHA256);
        byte[] name = der(0x30, der(0x31, der(0x30, OID_COMMON_NAME,
                der(0x0C, ALIAS.getBytes(StandardCharsets.UTF_8)))));

        byte[] serial = new byte[16];
        new SecureRandom().nextBytes(serial);
        serial[0] = (byte) ((serial[0] & 0x7F) | 0x40);

        long now = System.currentTimeMillis();
        byte[] validity = der(0x30, utcTime(now - DAY_MS), utcTime(now + VALID_DAYS * DAY_MS));

        ByteArrayOutputStream altNames = new ByteArrayOutputStream();
        byte[] localhost = der(0x82, "localhost".getBytes(StandardCharsets.UTF_8));
        altNames.write(localhost, 0, localhost.length);
        for (byte[] address : addresses) {
            byte[] encoded = der(0x87, address);
            altNames.write(encoded, 0, encoded.length);
        }
        byte[] extensions = der(0xA3, der(0x30, der(0x30, OID_SUBJECT_ALT_NAME,
                der(0x04, der(0x30, altNames.toByteArray())))));

        byte[] tbs = der(0x30,
                der(0xA0, der(0x02, new byte[] {2})),
                der(0x02, serial),
                algorithm,
                name,
                validity,
                name,
                pair.getPublic().getEncoded(),
                extensions);

        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(pair.getPrivate());
        signer.update(tbs);
        byte[] signature = signer.sign();
        byte[] signatureBits = new byte[signature.length + 1];
        System.arraycopy(signature, 0, signatureBits, 1, signature.length);
        return der(0x30, tbs, algorithm, der(0x03, signatureBits));
    }

    private static byte[] utcTime(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyMMddHHmmss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return der(0x17, format.format(new Date(millis)).getBytes(StandardCharsets.US_ASCII));
    }

    private static byte[] der(int tag, byte[]... parts) {
        int length = 0;
        for (byte[] part : parts) {
            length += part.length;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(length + 4);
        out.write(tag);
        if (length < 0x80) {
            out.write(length);
        } else if (length < 0x100) {
            out.write(0x81);
            out.write(length);
        } else {
            out.write(0x82);
            out.write(length >> 8);
            out.write(length);
        }
        for (byte[] part : parts) {
            out.write(part, 0, part.length);
        }
        return out.toByteArray();
    }

    private final class FixedKeyManager extends X509ExtendedKeyManager {
        @Override
        public String[] getClientAliases(String keyType, Principal[] issuers) {
            return null;
        }

        @Override
        public String chooseClientAlias(String[] keyType, Principal[] issuers, Socket socket) {
            return null;
        }

        @Override
        public String[] getServerAliases(String keyType, Principal[] issuers) {
            return new String[] {ALIAS};
        }

        @Override
        public String chooseServerAlias(String keyType, Principal[] issuers, Socket socket) {
            return ALIAS;
        }

        @Override
        public String chooseEngineServerAlias(String keyType, Principal[] issuers, SSLEngine engine) {
            return ALIAS;
        }

        @Override
        public X509Certificate[] getCertificateChain(String alias) {
            return new X509Certificate[] {certificate};
        }

        @Override
        public PrivateKey getPrivateKey(String alias) {
            return key;
        }
    }
}
