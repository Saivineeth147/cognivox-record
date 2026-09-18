/**
 * A local certificate authority, so `cvx record` can read TLS traffic.
 *
 * Recording an HTTPS call or a TLS database connection means terminating the
 * client's TLS with a certificate it will accept, reading the plaintext, and
 * re-originating TLS to the real server. That needs a CA the recorded process
 * trusts — which is why this exists and why it is deliberately conspicuous.
 *
 * Security properties this file is responsible for:
 *
 *  - The CA private key is written 0600 and never leaves the machine. Anyone
 *    holding it can impersonate any site to this user, so it is treated like
 *    any other private key, not like a cache artifact.
 *  - The CA is reused across runs. Regenerating it every time would train the
 *    developer to trust a new root repeatedly, which is a worse habit than the
 *    one certificate this installs.
 *  - Only processes `cvx` launches are told to trust it. Nothing is installed
 *    into the system or browser trust stores; the trust is scoped to the child
 *    through environment variables and disappears when it exits.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Where the CA lives, so it survives between recordings. */
export function certificateDirectory(): string {
  return join(process.env.HOME ?? homedir(), '.cognivox', 'ca');
}

export interface CertificateAuthority {
  readonly certificatePath: string;
  readonly certificatePem: string;
  readonly keyPath: string;
}

export interface LeafCertificate {
  readonly cert: string;
  readonly key: string;
}

/** Long enough to be useful, short enough not to be a permanent credential. */
const VALIDITY_DAYS = 365;
const CA_SUBJECT = '/CN=Cognivox Recording CA/O=Cognivox';

/**
 * Hostnames reach here from a CONNECT request or a connection string, both of
 * which are attacker-influenced in the general case. Even with `execFileSync`
 * avoiding a shell, a hostname containing `/` or `=` would rewrite the subject
 * fields, so anything that is not a plain DNS name or IP is refused outright.
 */
const SAFE_HOST = /^[a-zA-Z0-9._-]{1,253}$/;

export function isSafeHostname(host: string): boolean {
  return SAFE_HOST.test(host) && !host.includes('..');
}

function openssl(args: readonly string[]): void {
  execFileSync('openssl', args as string[], { stdio: 'pipe' });
}

/** True when certificate generation is possible at all on this machine. */
export function isOpensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the CA, creating it on first use.
 *
 * Elliptic-curve keys are used rather than RSA because a leaf certificate is
 * generated per host on first contact: RSA-2048 generation would add roughly a
 * tenth of a second to the first request to every new host.
 */
export function ensureCertificateAuthority(): CertificateAuthority {
  const directory = certificateDirectory();
  const keyPath = join(directory, 'ca.key');
  const certificatePath = join(directory, 'ca.crt');

  if (!existsSync(keyPath) || !existsSync(certificatePath)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
    chmodSync(keyPath, 0o600);
    openssl([
      'req', '-x509', '-new', '-key', keyPath, '-out', certificatePath,
      '-days', String(VALIDITY_DAYS), '-subj', CA_SUBJECT,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ]);
  }

  return {
    certificatePath,
    certificatePem: readFileSync(certificatePath, 'utf8'),
    keyPath,
  };
}

/** Leaf certificates are cached: generating one per connection is wasteful. */
const leafCache = new Map<string, LeafCertificate>();

/**
 * A certificate for `host`, signed by the local CA.
 *
 * The subject alternative name is what modern clients actually check; a
 * certificate carrying only a common name is rejected by every current TLS
 * stack, which would look like an unrelated network failure.
 */
export function leafCertificateFor(
  host: string,
  authority: CertificateAuthority
): LeafCertificate {
  if (!isSafeHostname(host)) {
    throw new Error(`Refusing to issue a certificate for an unusual hostname: ${host}`);
  }
  const cached = leafCache.get(host);
  if (cached) return cached;

  const directory = join(certificateDirectory(), 'hosts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, `${host}.key`);
  const certPath = join(directory, `${host}.crt`);
  const csrPath = join(directory, `${host}.csr`);
  const extPath = join(directory, `${host}.ext`);

  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
  chmodSync(keyPath, 0o600);
  openssl(['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', `/CN=${host}`]);

  const subjectAltName = /^[\d.]+$/.test(host) ? `IP:${host}` : `DNS:${host}`;
  writeFileSync(extPath, [
    `subjectAltName=${subjectAltName}`,
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
  ].join('\n'));

  openssl([
    'x509', '-req', '-in', csrPath, '-CA', authority.certificatePath,
    '-CAkey', authority.keyPath, '-CAcreateserial', '-out', certPath,
    '-days', String(VALIDITY_DAYS), '-extfile', extPath,
  ]);

  const leaf: LeafCertificate = {
    cert: readFileSync(certPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8'),
  };
  leafCache.set(host, leaf);
  return leaf;
}

/** Where OpenSSL keeps the system roots on this machine, if it says. */
function systemRootsPath(): string | null {
  try {
    const output = execFileSync('openssl', ['version', '-d'], { encoding: 'utf8' });
    const directory = output.match(/"([^"]+)"/)?.[1];
    if (!directory) return null;
    const bundle = join(directory, 'cert.pem');
    return existsSync(bundle) ? bundle : null;
  } catch {
    return null;
  }
}

/**
 * A trust bundle containing the system roots *and* the recording CA.
 *
 * This concatenation is not a convenience. `SSL_CERT_FILE` and
 * `REQUESTS_CA_BUNDLE` *replace* the trust store rather than extending it, so
 * pointing them at the recording CA alone leaves a process that trusts exactly
 * one authority — and every ordinary HTTPS call it makes fails with an
 * unrelated-looking "unable to get local issuer certificate". Recording must
 * not narrow what the app is able to reach.
 */
export function ensureTrustBundle(authority: CertificateAuthority): string {
  const bundlePath = join(certificateDirectory(), 'bundle.crt');
  const roots = systemRootsPath();
  const systemPem = roots ? readFileSync(roots, 'utf8') : '';
  writeFileSync(bundlePath, `${systemPem}\n${authority.certificatePem}`);
  return bundlePath;
}

/**
 * Environment that makes a child process trust the recording CA.
 *
 * Each runtime reads a different variable and none reads another's, so setting
 * only one silently fails to capture TLS from every other language. Node's
 * variable is additive and so gets the CA on its own; the rest are replacing,
 * and get the combined bundle.
 */
export function trustEnvironment(
  authority: CertificateAuthority,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const bundle = ensureTrustBundle(authority);
  return {
    ...base,
    NODE_EXTRA_CA_CERTS: authority.certificatePath,
    REQUESTS_CA_BUNDLE: bundle,
    SSL_CERT_FILE: bundle,
    CURL_CA_BUNDLE: bundle,
  };
}
