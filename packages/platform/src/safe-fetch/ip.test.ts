import { describe, expect, it } from 'vitest';
import { classifyIp, expandIpv6, isBlockedHostname } from './ip';

const reason = (ip: string) => {
  const v = classifyIp(ip);
  return v.allowed ? 'allowed' : v.reason;
};

describe('safe-fetch IP classifier', () => {
  it('[S6-01] blocks private, loopback, link-local, CGNAT, multicast, unspecified and reserved IPv4', () => {
    expect(reason('127.0.0.1')).toBe('loopback');
    expect(reason('127.255.255.254')).toBe('loopback');
    expect(reason('10.0.0.1')).toBe('private');
    expect(reason('172.16.0.1')).toBe('private');
    expect(reason('172.31.255.255')).toBe('private');
    expect(reason('192.168.1.1')).toBe('private');
    expect(reason('169.254.1.1')).toBe('link-local');
    expect(reason('100.64.0.1')).toBe('cgnat');
    expect(reason('100.127.255.255')).toBe('cgnat');
    expect(reason('224.0.0.1')).toBe('multicast');
    expect(reason('239.255.255.250')).toBe('multicast');
    expect(reason('0.0.0.0')).toBe('unspecified');
    expect(reason('0.1.2.3')).toBe('unspecified');
    expect(reason('255.255.255.255')).toBe('reserved');
    expect(reason('192.0.2.10')).toBe('reserved');
    expect(reason('198.18.0.1')).toBe('reserved');
  });

  it('[S6-01] blocks the cloud metadata addresses', () => {
    expect(reason('169.254.169.254')).toBe('metadata');
    expect(reason('168.63.129.16')).toBe('metadata');
    expect(reason('100.100.100.200')).toBe('metadata');
    expect(reason('fd00:ec2::254')).toBe('metadata');
    expect(reason('192.0.0.192')).toBe('reserved');
  });

  it('[S6-01] allows public IPv4 and IPv6 at the edges of blocked ranges', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1']) {
      expect(reason(ip), ip).toBe('allowed');
    }
    for (const ip of ['2606:4700:4700::1111', '2a00:1450:4003:80e::200e', '2001:4860:4860::8888']) {
      expect(reason(ip), ip).toBe('allowed');
    }
  });

  it('[S6-01] blocks IPv6 loopback, unspecified, unique-local, link-local, multicast and documentation', () => {
    expect(reason('::1')).toBe('loopback');
    expect(reason('0:0:0:0:0:0:0:1')).toBe('loopback');
    expect(reason('::')).toBe('unspecified');
    expect(reason('fc00::1')).toBe('unique-local');
    expect(reason('fd12:3456::1')).toBe('unique-local');
    expect(reason('fe80::1')).toBe('link-local');
    expect(reason('fe80::1%eth0')).toBe('link-local');
    expect(reason('febf::1')).toBe('link-local');
    expect(reason('fec0::1')).toBe('private');
    expect(reason('ff02::1')).toBe('multicast');
    expect(reason('2001:db8::1')).toBe('reserved');
    expect(reason('2001::1')).toBe('reserved');
    expect(reason('::2')).toBe('ipv4-mapped');
  });

  it('[S6-01] blocks IPv4-mapped and IPv4-compatible IPv6, judges NAT64 and 6to4 by the embedded IPv4', () => {
    expect(reason('::ffff:127.0.0.1')).toBe('ipv4-mapped');
    expect(reason('::ffff:7f00:1')).toBe('ipv4-mapped');
    expect(reason('::ffff:8.8.8.8')).toBe('ipv4-mapped');
    expect(reason('::ffff:169.254.169.254')).toBe('ipv4-mapped');
    expect(reason('::ffff:0:10.0.0.1')).toBe('ipv4-mapped');
    expect(reason('::127.0.0.1')).toBe('ipv4-mapped');
    expect(reason('64:ff9b::a9fe:a9fe')).toBe('metadata');
    expect(reason('64:ff9b::10.0.0.1')).toBe('private');
    expect(reason('64:ff9b::8.8.8.8')).toBe('allowed');
    expect(reason('2002:7f00:1::')).toBe('loopback');
    expect(reason('2002:0808:0808::1')).toBe('allowed');
  });

  it('[S6-01] treats anything that is not an IP literal as invalid', () => {
    expect(reason('example.com')).toBe('invalid');
    expect(reason('1.2.3')).toBe('invalid');
    expect(reason('::g')).toBe('invalid');
  });

  it('expands IPv6 forms', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(expandIpv6('2001:db8::')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(expandIpv6('nope')).toBeNull();
  });

  it('[S6-01] refuses host names reserved for local or internal use', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'api.localhost',
      'metadata.google.internal',
      'metadata',
      'printer.local',
      'intranet',
      'db.corp',
      'router.home.arpa',
    ]) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
    for (const host of ['example.com', 'feeds.kyero.com', 'www.resales-online.com.']) {
      expect(isBlockedHostname(host), host).toBe(false);
    }
  });
});
