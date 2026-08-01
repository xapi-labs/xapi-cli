/**
 * Tests for the outbound host allowlist that gates where the API key may be sent.
 */

import { describe, it, expect } from 'bun:test';
import { isAllowedHost, isLoopbackHost, assertAllowedHost, scheme } from '../config.ts';

describe('host allowlist', () => {
  describe('isAllowedHost — permitted', () => {
    const allowed = [
      'xapi.to',
      'action.xapi.to',
      'api.xapi.to',
      'www.xapi.to',
      'https://action.xapi.to/v1/actions/execute',
      'action.xapi.to:443',
      'xapi.xyz',
      'action.xapi.xyz',
      'https://api.xapi.xyz/api/auth/register',
      'localhost',
      'localhost:3003',
      'http://localhost:3003/health',
      '127.0.0.1',
      '127.0.0.1:8080',
      '127.1.2.3',      // any valid 127.0.0.0/8 IPv4
      'ACTION.XAPI.TO', // case-insensitive
    ];
    for (const host of allowed) {
      it(`allows ${host}`, () => {
        expect(isAllowedHost(host)).toBe(true);
      });
    }
  });

  describe('isAllowedHost — rejected', () => {
    const rejected = [
      'evil.com',
      'https://evil.com/steal',
      'action.xapi.to.evil.com',      // suffix spoof
      'xapi.to.evil.com',
      'notxapi.to',                    // no dot boundary
      'evilxapi.to',
      'xapi.xyz.attacker.net',
      'xapi.com',
      '',
      'xapi.to.',                      // trailing dot does not match exact
      '127.attacker.com',              // 127.* prefix spoof (domain, not IP)
      '127.evil.io',
      '127.0.0.1.nip.io',              // resolves to loopback for the attacker's convenience, but is a domain
      '127.foo',
      '127.256.0.1',                   // 127-prefixed but octet out of range
      '127.0.0.1.evil',                // extra label after a valid loopback IP
      'evil.example\\@action.xapi.to', // backslash trick: WHATWG hostname is evil.example
      'https://evil.example\\@action.xapi.to/v1/actions/execute',
      'action.xapi.to@evil.example',   // userinfo trick: hostname is evil.example
      'https://action.xapi.to@evil.example/v1',
    ];
    for (const host of rejected) {
      it(`rejects ${host}`, () => {
        expect(isAllowedHost(host)).toBe(false);
      });
    }
  });

  describe('isLoopbackHost', () => {
    it('recognizes loopback hosts', () => {
      expect(isLoopbackHost('localhost:3003')).toBe(true);
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('foo.localhost')).toBe(true);
    });
    it('rejects non-loopback hosts', () => {
      expect(isLoopbackHost('action.xapi.to')).toBe(false);
      expect(isLoopbackHost('evil.com')).toBe(false);
    });
  });

  describe('assertAllowedHost', () => {
    it('does not throw for an allowed host', () => {
      expect(() => assertAllowedHost('https://action.xapi.to/x')).not.toThrow();
    });
    it('throws a descriptive error for a disallowed host', () => {
      expect(() => assertAllowedHost('https://evil.com/x')).toThrow(/untrusted host "evil.com"/);
    });
  });

  describe('scheme', () => {
    it('uses http for loopback hosts', () => {
      expect(scheme('localhost:3003')).toBe('http');
      expect(scheme('127.0.0.1')).toBe('http');
    });
    it('uses https for remote hosts', () => {
      expect(scheme('action.xapi.to')).toBe('https');
    });
    it('no longer misclassifies localhost-prefixed remote hosts as http', () => {
      expect(scheme('localhost.evil.com')).toBe('https');
    });
  });
});
