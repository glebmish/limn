// The server tests fetch the canonical URL (http://limn.localhost:<port>). macOS and
// systemd-resolved answer *.localhost with loopback; plain glibc/musl resolvers
// (Debian/Alpine containers) do not. Pin the name to loopback for the test process so
// the suite does not depend on the host's resolver. Host/Origin headers are unchanged.
import dns from 'node:dns'

const realLookup = dns.lookup
;(dns as { lookup: unknown }).lookup = function lookup(hostname: string, ...rest: unknown[]) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) hostname = '127.0.0.1'
  return (realLookup as (...a: unknown[]) => unknown).call(dns, hostname, ...rest)
}

// tests/helpers/fakeAcpAgent.ts is spawned as `node fakeAcpAgent.ts`. Type stripping is
// on by default from Node 22.18 / 23.6; the engines floor (22.13) needs the flag. Spawned
// adapters inherit process.env, so set it here rather than in each CI leg.
if (!process.features.typescript && !(process.env.NODE_OPTIONS ?? '').includes('--experimental-strip-types')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --experimental-strip-types`.trim()
}
