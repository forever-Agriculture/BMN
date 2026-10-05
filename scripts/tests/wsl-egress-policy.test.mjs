// MODULE: wsl-egress-policy.test.mjs - the WSL session mediator's destination policy (profile gate P6)
import { describe, expect, it } from 'vitest'
import { classifyAddress, decideEgress, parseAddress } from '../lib/wsl-egress-policy.mjs'

const HOST = { hostAddresses: ['203.0.113.77', '2a01:4f8::77', '172.29.160.1'] }
const tcp = (...resolved) => ({ protocol: 'tcp', port: 443, resolved })

describe('WSL egress destination policy', () => {
  it('reads only literal addresses, in one canonical form, and refuses shorthand, names and zones', () => {
    expect(parseAddress('8.8.8.8')).toEqual({ family: 4, bytes: [8, 8, 8, 8], text: '8.8.8.8' })
    expect(parseAddress('2001:4860:4860::8888').text).toBe('2001:4860:4860:0:0:0:0:8888')
    expect(parseAddress('::FFFF:127.0.0.1').text).toBe('0:0:0:0:0:ffff:7f00:1')
    expect(parseAddress('1:2:3:4:5:6:1.2.3.4').text).toBe('1:2:3:4:5:6:102:304')
    // Forms some resolvers and URL parsers read as 127.0.0.1 are not reinterpreted here.
    for (const text of ['127.1', '0177.0.0.1', '0x7f.0.0.1', '2130706433', '127.0.0.01', '[::1]', 'localhost', '',
      '1:2:3:4:5:6:7:8:9', '1::2::3', ':::1', '1:2:3:4:5:6:7', '::ffff:1.2.3.256', '12345::1']) {
      expect(() => parseAddress(text), text).toThrow('not a literal IPv4 or IPv6 address')
    }
    expect(() => parseAddress('fe80::1%eth0')).toThrow('scoped (zone) address')
  })

  it('classifies special-purpose ranges, judging IPv4-carrying IPv6 forms by the IPv4 they carry', () => {
    const cases = {
      '8.8.8.8': 'public', '1.1.1.1': 'public', '2606:4700::1111': 'public', '::ffff:8.8.8.8': 'public',
      '0.0.0.0': 'unspecified', '10.1.2.3': 'private', '100.64.0.1': 'shared', '127.0.0.1': 'loopback', '127.255.255.254': 'loopback',
      '169.254.169.254': 'link-local', '172.16.0.1': 'private', '172.31.255.255': 'private', '172.32.0.1': 'public',
      '192.0.0.9': 'reserved', '192.0.2.1': 'documentation', '192.168.1.1': 'private', '198.18.0.1': 'reserved',
      '198.51.100.1': 'documentation', '203.0.113.1': 'documentation', '224.0.0.251': 'multicast', '255.255.255.255': 'reserved',
      '::': 'unspecified', '::1': 'loopback', '::8.8.8.8': 'reserved', '::ffff:127.0.0.1': 'loopback', '::ffff:7f00:1': 'loopback',
      '::ffff:10.0.0.1': 'private', '::ffff:169.254.169.254': 'link-local', '64:ff9b::7f00:1': 'loopback',
      '64:ff9b::808:808': 'public', '64:ff9b:1::1': 'private', '2002:c0a8:101::1': 'private', '2002:808:808::1': 'public',
      '2001::1': 'reserved', '2001:db8::1': 'documentation', '3fff::1': 'documentation', 'fc00::1': 'unique-local',
      'fd12:3456::1': 'unique-local', 'fe80::1': 'link-local', 'febf::1': 'link-local', 'fec0::1': 'site-local',
      'ff02::1': 'multicast', '100::1': 'reserved', '1::': 'reserved', '4000::1': 'reserved', '2000::1': 'public'
    }
    expect(Object.fromEntries(Object.keys(cases).map((address) => [address, classifyAddress(address)]))).toEqual(cases)
  })

  it('allows TCP only to public addresses that are not this computer, and pins the addresses it allowed', () => {
    expect(decideEgress(tcp('140.82.112.3', '2606:50c0:8000::153'), HOST))
      .toEqual({ allow: true, addresses: ['140.82.112.3', '2606:50c0:8000:0:0:0:0:153'] })
    expect(decideEgress(tcp('8.8.8.8', '8.8.8.8', '::ffff:8.8.8.8'), HOST)).toEqual({ allow: true, addresses: ['8.8.8.8', '0:0:0:0:0:ffff:808:808'] })
    expect(decideEgress({ protocol: 'tcp', port: 1, resolved: ['8.8.8.8'] }).allow).toBe(true)
    expect(decideEgress({ protocol: 'tcp', port: 65535, resolved: ['8.8.8.8'] }).allow).toBe(true)
  })

  it('refuses the hop when any answer is forbidden, so a rebinding answer cannot ride along', () => {
    expect(decideEgress(tcp('140.82.112.3', '127.0.0.1'), HOST)).toEqual({ allow: false, reason: 'the destination is loopback', address: '127.0.0.1' })
    expect(decideEgress(tcp('140.82.112.3', '::ffff:192.168.1.1'), HOST)).toMatchObject({ allow: false, reason: 'the destination is private' })
    expect(decideEgress(tcp('169.254.169.254'), HOST)).toMatchObject({ allow: false, reason: 'the destination is link-local' })
    expect(decideEgress(tcp('140.82.112.3', 'not-an-address'), HOST)).toMatchObject({ allow: false })
  })

  it('refuses this computer by any of its addresses, public and hairpin ones included, in every carrying form', () => {
    for (const address of ['203.0.113.77', '::ffff:203.0.113.77', '64:ff9b::cb00:714d', '2002:cb00:714d::1', '2a01:4f8::77', '2a01:04f8:0::0077']) {
      expect(decideEgress(tcp(address), { hostAddresses: ['203.0.113.77', '2a01:4f8::77'] }), address)
        .toMatchObject({ allow: false, reason: 'the destination is this computer' })
    }
    // The WSL virtual switch address is private anyway; a public host address is refused only because it is the host's.
    expect(decideEgress(tcp('172.29.160.1'), HOST).reason).toBe('the destination is this computer')
    expect(decideEgress(tcp('203.0.113.78'), { hostAddresses: ['203.0.113.77'] }).reason).toBe('the destination is documentation')
    expect(decideEgress(tcp('8.8.4.4'), { hostAddresses: ['8.8.8.8'] }).allow).toBe(true)
    expect(decideEgress(tcp('8.8.8.8'), { hostAddresses: ['8.8.8.8'] }).allow).toBe(false)
  })

  it('offers no UDP, no other protocol, no port outside 1–65535 and no empty or unreadable answer', () => {
    expect(decideEgress({ protocol: 'udp', port: 53, resolved: ['8.8.8.8'] })).toMatchObject({ allow: false, reason: 'udp is not offered; only TCP leaves the session' })
    expect(decideEgress({ protocol: 'TCP', port: 443, resolved: ['8.8.8.8'] }).allow).toBe(false)
    for (const port of [0, 65536, -1, 1.5, '443', null]) expect(decideEgress({ protocol: 'tcp', port, resolved: ['8.8.8.8'] }).allow, String(port)).toBe(false)
    expect(decideEgress(tcp()).reason).toBe('the name resolved to no address')
    expect(decideEgress({ protocol: 'tcp', port: 443, resolved: '8.8.8.8' }).allow).toBe(false)
    expect(decideEgress(tcp('8.8.8.8'), { hostAddresses: ['host.example'] }).allow).toBe(false)
    expect(decideEgress(undefined).allow).toBe(false)
  })

  it('decides each redirect hop and each new resolution afresh', () => {
    // A public first hop does not carry its permission to a redirect that lands on the metadata service.
    const hops = [tcp('140.82.112.3'), tcp('169.254.169.254'), tcp('140.82.112.4')].map((hop) => decideEgress(hop, HOST).allow)
    expect(hops).toEqual([true, false, true])
  })
})
