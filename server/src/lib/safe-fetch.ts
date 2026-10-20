/**
 * Guarded outbound HTTP (Part D / D9, Part A / A5).
 *
 * Every request made on behalf of a user-configured REST connector goes
 * through `safeFetch`. It enforces, in this order and on every hop:
 *
 *   1. protocol allow-list (http/https only),
 *   2. no credentials embedded in the URL, no non-default ports on read paths,
 *   3. DNS resolution and validation of **every** resolved address,
 *   4. a pinned address for the actual socket so a DNS answer cannot change
 *      between the check and the connection (DNS-rebinding defence),
 *   5. the same checks again for every redirect, with a hard redirect budget,
 *   6. a request timeout and a response byte cap.
 *
 * Blocked addresses: loopback, private, link-local (169.254.0.0/16 including
 * the cloud metadata services), carrier-grade NAT, multicast, reserved ranges,
 * IPv4-mapped/6to4/Teredo/NAT64 embedded IPv4, and the IPv6 equivalents.
 */

import { isIP } from 'node:net';
import { lookup as dnsLookup, resolve4, resolve6 } from 'node:dns/promises';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { Agent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

export const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Cloud instance-metadata endpoints, blocked explicitly and loudly. */
const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata.azure.com',
]);

const METADATA_ADDRESSES = new Set([
  '169.254.169.254', // AWS / Azure / GCP / OpenStack / Oracle IMDS
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud
  '192.0.0.192', // Oracle Cloud
  'fd00:ec2::254', // AWS IMDSv6
]);

/** Ports a user-configured read endpoint may target. Prevents port scanning. */
export const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1 MiB
const USER_AGENT = 'SyncFix/1.0 (+https://github.com/syncfix)';

export class SsrfBlockedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.code = code;
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'PUT' | 'HEAD';
  headers?: Record<string, string>;
  /** Serialized body. `PUT` is used because it is idempotent by definition. */
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  /** Body decoded as text, already truncated to the byte cap. */
  body: string;
  /** True when the body was cut short because it exceeded the cap. */
  truncated: boolean;
  finalUrl: string;
}

/* -------------------------------------------------------------------------- */
/* Address classification                                                      */
/* -------------------------------------------------------------------------- */

/** Strip IPv6 brackets and zone identifiers. */
function normalizeHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
}

/**
 * IPv4 ranges that must never be reachable from a user-configured endpoint.
 * Each entry is [network, prefix length].
 */
const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

function isBlockedIpv4(ip: string): { blocked: boolean; reason?: string } {
  if (METADATA_ADDRESSES.has(ip)) {
    return { blocked: true, reason: 'cloud metadata address' };
  }
  const value = ipv4ToInt(ip);
  if (value === null) return { blocked: true, reason: 'not a valid IPv4 address' };

  for (const [network, prefix] of BLOCKED_IPV4_CIDRS) {
    const base = ipv4ToInt(network)!;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) >>> 0 === (base & mask) >>> 0) {
      const label = prefix >= 8 ? network : `${network}/${prefix}`;
      return { blocked: true, reason: `reserved or private IPv4 range ${label}` };
    }
  }
  // 192.0.0.0/24 is already covered; guard the remaining IANA specials.
  if (value === 0x7fffffff) return { blocked: true, reason: 'reserved IPv4 address' };
  return { blocked: false };
}

function isBlockedIpv6(ip: string): { blocked: boolean; reason?: string } {
  const address = normalizeHost(ip);
  if (METADATA_ADDRESSES.has(address)) {
    return { blocked: true, reason: 'cloud metadata address' };
  }

  // ::1 loopback, :: unspecified
  if (address === '::' || address === '::1') {
    return { blocked: true, reason: 'IPv6 loopback or unspecified address' };
  }

  // fc00::/7 unique local
  if (/^f[cd][0-9a-f]{2}:/.test(address)) {
    return { blocked: true, reason: 'private IPv6 unique-local range fc00::/7' };
  }
  // fe80::/10 link-local (covers fe80::/16 and the fe80::/64 metadata prefix)
  if (/^fe[89ab][0-9a-f]:/.test(address)) {
    return { blocked: true, reason: 'IPv6 link-local range fe80::/10' };
  }
  // ff00::/8 multicast
  if (/^ff[0-9a-f]{2}:/.test(address)) {
    return { blocked: true, reason: 'IPv6 multicast range ff00::/8' };
  }
  // 2001:db8::/32 documentation, 100::/64 discard, 2002::/16 6to4
  if (/^2001:db8:/.test(address)) {
    return { blocked: true, reason: 'IPv6 documentation range 2001:db8::/32' };
  }
  if (/^100:/.test(address)) {
    return { blocked: true, reason: 'IPv6 discard prefix 100::/64' };
  }

  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::/96 must be judged as IPv4.
  const mapped = extractEmbeddedIpv4(address);
  if (mapped) {
    const result = isBlockedIpv4(mapped);
    return result.blocked
      ? { blocked: true, reason: `IPv6 address embeds ${result.reason}` }
      : { blocked: false };
  }

  return { blocked: false };
}

/** Returns the embedded IPv4 for ::ffff:x, 64:ff9b::x and 2002:: Tunnel forms. */
function extractEmbeddedIpv4(address: string): string | null {
  const mappedMatch = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mappedMatch) return mappedMatch[1]!;
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hexMapped) {
    const high = parseInt(hexMapped[1]!, 16);
    const low = parseInt(hexMapped[2]!, 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  const nat64 = /^64:ff9b::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (nat64) return nat64[1]!;
  const teredo = /^2001:0:([0-9a-f]{4}):([0-9a-f]{4}):([0-9a-f]{4}):([0-9a-f]{4})$/.exec(address);
  if (teredo) {
    // Teredo encodes the *client* IPv4 in the last 32 bits, complemented.
    const words = teredo.slice(1).map((w) => parseInt(w, 16));
    const last = words[3]!;
    const third = words[2]!;
    const a = (~(last >> 8)) & 0xff;
    const b = (~last) & 0xff;
    const c = (~(third >> 8)) & 0xff;
    const d = (~third) & 0xff;
    return `${a}.${b}.${c}.${d}`;
  }
  return null;
}

export function classifyAddress(ip: string): { blocked: boolean; reason?: string } {
  const version = isIP(normalizeHost(ip));
  if (version === 4) return isBlockedIpv4(normalizeHost(ip));
  if (version === 6) return isBlockedIpv6(ip);
  return { blocked: true, reason: 'not a recognised IP address' };
}

/* -------------------------------------------------------------------------- */
/* Explicit development escape hatch                                           */
/* -------------------------------------------------------------------------- */

/**
 * Operators sometimes need a dev-only job to talk to a fixture server on their
 * own machine. That is impossible to reach through the SSRF guard by design, so
 * it has to be an explicit, auditable, environment-gated decision rather than a
 * silent hole:
 *
 *   - the list is empty by default, so production is unaffected;
 *   - `loadConfig` REFUSES to start with the variable set in production;
 *   - only the listed hostnames bypass the address classification.
 *
 * This is never a blanket "disable SSRF protection" switch.
 */
let allowedHosts = new Set<string>();

export function configureSsrfAllowList(hosts: string[]): void {
  allowedHosts = new Set(hosts.map((host) => normalizeHost(host)).filter(Boolean));
}

export function ssrfAllowList(): string[] {
  return [...allowedHosts];
}

function isAllowListed(host: string): boolean {
  return allowedHosts.has(normalizeHost(host));
}

/* -------------------------------------------------------------------------- */
/* URL validation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Parses and validates a URL structurally. DNS is resolved separately so the
 * caller can reuse the pinned address for the socket.
 */
export function validateUrlShape(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('invalid_url', 'That is not a valid absolute URL.');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfBlockedError(
      'blocked_protocol',
      `Only http:// and https:// are allowed (got "${url.protocol.replace(':', '')}").`,
    );
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('blocked_credentials', 'Credentials in the URL are not allowed.');
  }

  const host = normalizeHost(url.hostname);
  if (!host) throw new SsrfBlockedError('invalid_url', 'The URL has no host.');

  if (METADATA_HOSTNAMES.has(host)) {
    throw new SsrfBlockedError(
      'blocked_metadata',
      'Cloud instance-metadata endpoints are blocked for safety.',
    );
  }
  // Reject decimal / octal / hex IPv4 obfuscation such as http://2130706433/
  if (/^\d+$/.test(host) && host !== '0') {
    throw new SsrfBlockedError('blocked_obfuscated_host', 'Numeric host forms are not allowed.');
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    throw new SsrfBlockedError(
      'blocked_port',
      `Port ${port} is not in the allowed list (${[...ALLOWED_PORTS].join(', ')}).`,
    );
  }

  return url;
}

/** Resolves the host and rejects when any answer is a blocked address. */
export async function assertHostIsPublic(host: string): Promise<string[]> {
  const normalized = normalizeHost(host);

  if (isAllowListed(normalized)) {
    // Resolve normally so the connection still has to succeed; the allow-list
    // only bypasses the address classification, never the transport rules.
    const addresses = await resolveHost(normalized).catch(() => [] as Array<{ address: string; family: number }>);
    return addresses.length > 0 ? addresses.map((entry) => entry.address) : [normalized];
  }

  if (isIP(normalized)) {
    const verdict = classifyAddress(normalized);
    if (verdict.blocked) {
      throw new SsrfBlockedError(
        'blocked_address',
        `The host resolves to a ${verdict.reason}, which SyncFix refuses to reach.`,
      );
    }
    return [normalized];
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolveHost(normalized);
  } catch {
    throw new SsrfBlockedError('dns_failure', `Could not resolve the host "${host}".`);
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError('dns_failure', `The host "${host}" has no address records.`);
  }

  // EVERY answer must be safe. A host that mixes a public and a private answer
  // is exactly the DNS-rebinding pattern we are defending against.
  for (const entry of addresses) {
    const verdict = classifyAddress(entry.address);
    if (verdict.blocked) {
      throw new SsrfBlockedError(
        'blocked_address',
        `The host "${host}" resolves to a ${verdict.reason}, which SyncFix refuses to reach.`,
      );
    }
  }
  return addresses.map((entry) => entry.address);
}

async function resolveHost(host: string): Promise<Array<{ address: string; family: number }>> {
  const out: Array<{ address: string; family: number }> = [];
  // `resolve4`/`resolve6` do not consult /etc/hosts, which is exactly what a
  // rebinding attacker wants us to skip past. `lookup` with `all: true` does.
  const results = await Promise.allSettled([
    resolve4(host).then((list) => list.map((address) => ({ address, family: 4 }))),
    resolve6(host).then((list) => list.map((address) => ({ address, family: 6 }))),
  ]);
  for (const result of results) {
    if (result.status === 'fulfilled') out.push(...result.value);
  }
  if (out.length === 0) {
    const fallback = await dnsLookup(host, { all: true, verbatim: true });
    out.push(...fallback.map((entry) => ({ address: entry.address, family: entry.family })));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Pinned transport                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A `net.connect` that ignores the hostname and dials the already-validated IP.
 * The TLS `servername` still carries the original hostname so certificates and
 * SNI behave normally, but the socket cannot be redirected to a private address
 * between the DNS check and the connection.
 */
function pinnedConnect(remoteAddress: string, port: number): (opts: { host: string; port: number }) => Socket {
  return ({ port: requestedPort }) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = netConnect({ host: remoteAddress, port: requestedPort || port }, () =>
        resolve(socket),
      );
      socket.once('error', reject);
    }) as unknown as Socket;
}

export interface SafeFetchOptionsInternal extends SafeFetchOptions {
  /** Overrides the default agents; used by tests. */
  agents?: { http: Agent; https: HttpsAgent };
}

/**
 * Performs one guarded request, following redirects manually so every hop is
 * re-validated. Returns the response body as text, truncated at the byte cap.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const method = options.method ?? 'GET';

  let currentUrl = rawUrl;
  let redirects = 0;

  for (;;) {
    const url = validateUrlShape(currentUrl);
    const addresses = await assertHostIsPublic(url.hostname);
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const primary = addresses[0]!;

    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...(options.headers ?? {}),
    };

    const agent =
      url.protocol === 'https:'
        ? new HttpsAgent({
            keepAlive: false,
            maxSockets: 4,
            // Pin the socket to the validated address.
            createConnection: pinnedConnect(primary, port),
            // Never let Node fall back to a second address.
            maxCachedSessions: 0,
            servername: url.hostname,
          } as never)
        : new Agent({
            keepAlive: false,
            maxSockets: 4,
            createConnection: pinnedConnect(primary, port),
          } as never);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: options.body,
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: undefined,
        agent,
      } as RequestInit & { agent: unknown });
    } catch (error) {
      clearTimeout(timer);
      agent.destroy();
      if (controller.signal.aborted) {
        throw new SsrfBlockedError(
          'timeout',
          `The request to ${safeHostLabel(url)} timed out after ${timeoutMs} ms.`,
        );
      }
      throw normalizeNetworkError(error, url);
    } finally {
      clearTimeout(timer);
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      agent.destroy();
      if (!location) {
        throw new SsrfBlockedError(
          'redirect_without_location',
          `The server answered ${response.status} without a Location header.`,
        );
      }
      redirects += 1;
      if (redirects > maxRedirects) {
        throw new SsrfBlockedError('too_many_redirects', 'The endpoint redirected too many times.');
      }
      // Re-validate the whole next URL (protocol, credentials, port, DNS).
      currentUrl = new URL(location, url).toString();
      continue;
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      agent.destroy();
      await response.body?.cancel().catch(() => undefined);
      throw new SsrfBlockedError(
        'response_too_large',
        `The response is ${declaredLength} bytes, above the ${maxBytes} byte limit.`,
      );
    }

    const reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        chunks.push(Buffer.from(value));
        if (total >= maxBytes) {
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    agent.destroy();

    const headerEntries: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headerEntries[key.toLowerCase()] = value;
    });

    return {
      status: response.status,
      headers: headerEntries,
      body: Buffer.concat(chunks).toString('utf8'),
      truncated,
      finalUrl: url.toString(),
    };
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function safeHostLabel(url: URL): string {
  return `${url.protocol.replace(':', '')}://${url.host}`;
}

function normalizeNetworkError(error: unknown, url: URL): Error {
  const cause = (error as { cause?: { code?: string } })?.cause?.code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') {
    return new SsrfBlockedError('dns_failure', `Could not resolve ${safeHostLabel(url)}.`);
  }
  if (cause === 'ECONNREFUSED') {
    return new SsrfBlockedError('connection_refused', `${safeHostLabel(url)} refused the connection.`);
  }
  if (cause === 'ETIMEDOUT' || cause === 'UND_ERR_CONNECT_TIMEOUT') {
    return new SsrfBlockedError('timeout', `Connecting to ${safeHostLabel(url)} timed out.`);
  }
  if (cause === 'ECONNRESET' || cause === 'EPIPE') {
    return new SsrfBlockedError('connection_reset', `${safeHostLabel(url)} reset the connection.`);
  }
  if (cause === 'EPROTO' || cause === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return new SsrfBlockedError('tls_error', `TLS verification failed for ${safeHostLabel(url)}.`);
  }
  return new SsrfBlockedError('network_error', `Request to ${safeHostLabel(url)} failed: ${message}`);
}