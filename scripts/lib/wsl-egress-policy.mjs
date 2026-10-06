// MODULE: wsl-egress-policy.mjs - which resolved destinations a WSL session's network mediator may connect to
// Preparatory (Story 53.5, profile gate P6): pure policy, tested on Linux. The mediator resolves names itself, asks
// this policy about every address it would use (and again for every redirect hop or re-resolution), then connects only
// to the addresses the decision returns. Guest code never gets a host-network descriptor. Actual WSL routing, NAT or
// mirrored networking and Windows firewall behaviour are measured natively, not here.
import { ProtocolError } from './wsl-session-protocol.mjs'

const fail = (reason) => { throw new ProtocolError('PROTOCOL', reason) }

/** Four decimal octets, no leading zeros: shorthand, octal, hex and integer forms are refused, never reinterpreted. */
function ipv4Bytes(text) {
  const parts = text.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255)) return null
  return parts.map(Number)
}

function ipv6Bytes(value) {
  let text = value
  // A trailing dotted IPv4 (::ffff:192.0.2.1) is the last two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(text)
  if (dotted) {
    const embedded = ipv4Bytes(dotted[2])
    if (!embedded) return null
    text = `${dotted[1]}${((embedded[0] << 8) | embedded[1]).toString(16)}:${((embedded[2] << 8) | embedded[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (half) => half === '' ? [] : half.split(':')
  const left = groups(halves[0]), right = halves.length === 2 ? groups(halves[1]) : []
  if (![...left, ...right].every((group) => /^[0-9a-f]{1,4}$/iu.test(group))) return null
  const known = left.length + right.length
  if (halves.length === 1 ? known !== 8 : known > 7) return null
  const words = [...left, ...Array(8 - known).fill('0'), ...right].map((group) => parseInt(group, 16))
  return words.flatMap((word) => [word >> 8, word & 0xff])
}

/** `{ family, bytes, text }` for a literal address; zone indexes, brackets and names are refused. */
export function parseAddress(value) {
  const text = String(value)
  if (text.includes('%')) fail('a scoped (zone) address cannot leave the session')
  const v4 = ipv4Bytes(text)
  if (v4) return { family: 4, bytes: v4, text: v4.join('.') }
  const v6 = text.includes(':') ? ipv6Bytes(text) : null
  if (v6) {
    const words = Array.from({ length: 8 }, (_, index) => ((v6[index * 2] << 8) | v6[index * 2 + 1]).toString(16))
    return { family: 6, bytes: v6, text: words.join(':') }
  }
  return fail(`"${text.slice(0, 64)}" is not a literal IPv4 or IPv6 address; the mediator resolves names before asking`)
}

const inPrefix = (bytes, prefix, length) => {
  for (let bit = 0; bit < length; bit += 1) {
    const mask = 0x80 >> (bit % 8)
    if ((bytes[bit >> 3] & mask) !== (prefix[bit >> 3] & mask)) return false
  }
  return true
}

// IANA special-purpose registries; anything listed is never a public destination. Conservative: a few globally
// reachable assignments inside these blocks (192.0.0.9, parts of 2001::/23) are refused too.
const V4_SPECIAL = [
  ['0.0.0.0', 8, 'unspecified'], ['10.0.0.0', 8, 'private'], ['100.64.0.0', 10, 'shared'], ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'], ['172.16.0.0', 12, 'private'], ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'], ['192.88.99.0', 24, 'reserved'], ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'], ['198.51.100.0', 24, 'documentation'], ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved']
].map(([address, length, category]) => [ipv4Bytes(address), length, category])
const V6_SPECIAL = [
  ['::', 128, 'unspecified'], ['::1', 128, 'loopback'], ['::', 96, 'reserved'], ['64:ff9b:1::', 48, 'private'], ['100::', 64, 'reserved'],
  ['2001::', 23, 'reserved'], ['2001:db8::', 32, 'documentation'], ['3fff::', 20, 'documentation'],
  ['5f00::', 16, 'reserved'], ['fc00::', 7, 'unique-local'], ['fe80::', 10, 'link-local'], ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast']
].map(([address, length, category]) => [ipv6Bytes(address), length, category])
// IPv6 forms that carry an IPv4 destination: [prefix, length, offset of the embedded IPv4 bytes].
const V6_EMBEDDING = [['::ffff:0:0', 96, 12], ['64:ff9b::', 96, 12], ['2002::', 16, 2]]
  .map(([address, length, offset]) => [ipv6Bytes(address), length, offset])

/**
 * The address's category: `public` or the special-purpose range it falls in. IPv4-mapped, NAT64 and 6to4 addresses are
 * judged by the IPv4 destination they carry, so ::ffff:127.0.0.1 is loopback; IPv6 outside 2000::/3 is reserved.
 */
export function classifyAddress(value) {
  const address = typeof value === 'string' ? parseAddress(value) : value
  if (address.family === 4) return V4_SPECIAL.find(([prefix, length]) => inPrefix(address.bytes, prefix, length))?.[2] ?? 'public'
  for (const [prefix, length, category] of V6_SPECIAL) if (inPrefix(address.bytes, prefix, length)) return category
  for (const [prefix, length, offset] of V6_EMBEDDING) {
    if (inPrefix(address.bytes, prefix, length)) {
      return classifyAddress({ family: 4, bytes: address.bytes.slice(offset, offset + 4) })
    }
  }
  return inPrefix(address.bytes, [0x20], 3) ? 'public' : 'reserved'
}

const sameDestination = (left, right) => {
  const embedded = (address) => {
    if (address.family === 4) return address.bytes.join('.')
    const carried = V6_EMBEDDING.find(([prefix, length]) => inPrefix(address.bytes, prefix, length))
    return carried ? address.bytes.slice(carried[2], carried[2] + 4).join('.') : address.text
  }
  return embedded(left) === embedded(right)
}

/**
 * One connection decision. `request` is `{ protocol, port, resolved }`: the addresses the mediator's own resolver
 * returned for this hop. `context.hostAddresses` lists the Windows host's own addresses, including public and hairpin
 * ones, which are refused like loopback. Only TCP to ports 1–65535 is offered (UDP, LAN and VPN destinations are
 * deferred to the owner). Every resolved address must be public and not the host's: one forbidden answer refuses the
 * whole hop, so a rebinding answer cannot ride along. An allowed decision lists the only addresses the mediator may
 * connect to; it must not resolve again for this hop, and a redirect or a new resolution is a new decision.
 */
export function decideEgress(request, context = {}) {
  const refuse = (reason, address = null) => ({ allow: false, reason, address })
  if (request?.protocol !== 'tcp') return refuse(`${String(request?.protocol).slice(0, 16)} is not offered; only TCP leaves the session`)
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) return refuse('the port is not 1–65535')
  if (!Array.isArray(request.resolved) || request.resolved.length === 0) return refuse('the name resolved to no address')
  let hosts, addresses
  try {
    hosts = (context.hostAddresses ?? []).map(parseAddress)
    addresses = request.resolved.map(parseAddress)
  } catch (error) {
    return refuse(error instanceof ProtocolError ? error.reason : 'an address could not be read')
  }
  for (const address of addresses) {
    if (hosts.some((host) => sameDestination(host, address))) return refuse('the destination is this computer', address.text)
    const category = classifyAddress(address)
    if (category !== 'public') return refuse(`the destination is ${category}`, address.text)
  }
  return { allow: true, addresses: [...new Set(addresses.map((address) => address.text))] }
}
