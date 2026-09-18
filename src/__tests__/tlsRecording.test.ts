/**
 * Tests for TLS recording.
 *
 * Both cases here are regressions from bugs that only appeared against real
 * servers, and both were invisible to the type checker and to every test that
 * did not actually open a connection.
 */

import { readFileSync } from 'fs';
import {
  isSafeHostname, isOpensslAvailable, ensureCertificateAuthority,
  ensureTrustBundle, trustEnvironment, leafCertificateFor, systemRootsPath, trustScope,
} from '../record/tls/certificateAuthority';
import { toOptions } from '../record/nodeProxyShim';

describe('isSafeHostname', () => {
  it('should accept an ordinary hostname', () => {
    expect(isSafeHostname('api.github.com')).toBe(true);
  });

  it('should reject a name that would rewrite certificate subject fields', () => {
    // These reach us from a CONNECT authority or a connection string, so they
    // are attacker-influenced even though no shell is involved.
    expect(isSafeHostname('evil/CN=bank.com')).toBe(false);
    expect(isSafeHostname('a=b')).toBe(false);
  });

  it('should reject traversal-looking names', () => {
    expect(isSafeHostname('../../etc/passwd')).toBe(false);
    expect(isSafeHostname('a..b')).toBe(false);
  });
});

describe('the node shim request options', () => {
  it('should default an https URL to port 443, not 80', () => {
    // Defaulting to 80 tunnelled HTTPS to the plaintext port, where the
    // handshake failed with "wrong version number" and looked like a proxy bug.
    expect(toOptions(['https://api.github.com/zen'] as never)!.port).toBe(443);
  });

  it('should still default an http URL to port 80', () => {
    expect(toOptions(['http://example.com/x'] as never)!.port).toBe(80);
  });

  it('should keep an explicit port', () => {
    expect(toOptions(['https://example.com:8443/x'] as never)!.port).toBe('8443');
  });
});

const describeWithOpenssl = isOpensslAvailable() ? describe : describe.skip;

describeWithOpenssl('the trust bundle', () => {
  // Pointing SSL_CERT_FILE at the recording CA alone *replaces* the trust
  // store, leaving the app able to verify exactly one authority — every
  // ordinary HTTPS call then fails with "unable to get local issuer". The
  // invariant on every OS is therefore: never narrow trust.
  const hasSystemRoots = systemRootsPath() !== null;
  const itWithRoots = hasSystemRoots ? it : it.skip;

  itWithRoots('should contain the system roots as well as the recording CA', () => {
    const authority = ensureCertificateAuthority();
    const bundle = readFileSync(ensureTrustBundle(authority) as string, 'utf8');
    const certificateCount = (bundle.match(/BEGIN CERTIFICATE/g) || []).length;
    expect(bundle).toContain(authority.certificatePem.trim());
    expect(certificateCount).toBeGreaterThan(1);
  });

  itWithRoots('should point the replacing variables at the bundle, not the bare CA', () => {
    const authority = ensureCertificateAuthority();
    const env = trustEnvironment(authority, {});
    expect(env.SSL_CERT_FILE).not.toBe(authority.certificatePath);
    expect(env.REQUESTS_CA_BUNDLE).toBe(env.SSL_CERT_FILE);
  });

  it('should not set the replacing variables at all when there are no system roots', () => {
    // Windows OpenSSL ships no cert.pem — its trust is in the Windows store.
    // A bundle of just our CA there would narrow every OpenSSL-based client
    // to one authority. Skipping interception beats breaking the app.
    const authority = ensureCertificateAuthority();
    const env = trustEnvironment(authority, { PATH: '/bin' }, null);
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(env.CURL_CA_BUNDLE).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBe(authority.certificatePath);
  });

  it('should report the trust scope so the summary can explain a TLS zero', () => {
    expect(trustScope(null)).toBe('node-only');
    expect(trustScope('/some/cert.pem')).toBe('all');
  });

  it('should give Node the bare CA, whose variable is additive', () => {
    const authority = ensureCertificateAuthority();
    expect(trustEnvironment(authority, {}).NODE_EXTRA_CA_CERTS)
      .toBe(authority.certificatePath);
  });
});

describeWithOpenssl('leaf certificates', () => {
  it('should carry a subject alternative name, which is what clients check', () => {
    const leaf = leafCertificateFor('example.test', ensureCertificateAuthority());
    const { X509Certificate } = require('crypto');
    expect(new X509Certificate(leaf.cert).subjectAltName).toContain('example.test');
  });

  it('should refuse to issue for a hostname that could rewrite the subject', () => {
    expect(() => leafCertificateFor('evil/CN=bank.com', ensureCertificateAuthority()))
      .toThrow(/unusual hostname/);
  });
});
