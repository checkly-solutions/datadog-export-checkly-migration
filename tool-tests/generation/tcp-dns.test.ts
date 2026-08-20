/**
 * Generation tests for the TCP and DNS monitor generators.
 *
 * Calls generateTcpMonitorCode (step 04b) and generateDnsMonitorCode
 * (step 04c) directly with inline-mode options ({ withAlertChannels: false })
 * and asserts structurally on the returned strings. No subprocess, no file
 * writes; structural assertions only, never snapshots.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateTcpMonitorCode, buildMappingCsvForTcp } from '../../src/04b-generate-tcp-monitor-constructs.ts';
import { generateDnsMonitorCode, buildMappingCsvForDns } from '../../src/04c-generate-dns-monitor-constructs.ts';
import { uniqueLogicalId } from '../../src/shared/utils.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): any {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'unit', name), 'utf-8')
  );
}

const tcpFixture = loadFixture('tcp-test.json');
const dnsFixture = loadFixture('dns-test.json');

/**
 * Both generators call filterAndRemapTags, which reads DD_TAGS_EXCLUDE,
 * DD_TAGS_EXCLUDE_ALL, and DD_TAGS_REMAP at call time. Snapshot and clear all
 * three before the tests and restore them exactly afterwards.
 */
const DD_TAG_VARS = ['DD_TAGS_EXCLUDE', 'DD_TAGS_EXCLUDE_ALL', 'DD_TAGS_REMAP'] as const;
let savedTagEnv: Record<string, string | undefined> = {};

before(() => {
  savedTagEnv = {};
  for (const name of DD_TAG_VARS) {
    savedTagEnv[name] = process.env[name];
    delete process.env[name];
  }
});

after(() => {
  for (const name of DD_TAG_VARS) {
    if (savedTagEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedTagEnv[name];
    }
  }
});

describe('generateTcpMonitorCode: inline mode baseline', () => {
  it('emits a TcpMonitor constructor call with the derived logical id', () => {
    const output = generateTcpMonitorCode(tcpFixture, { withAlertChannels: false });
    assert.ok(output.includes('new TcpMonitor("tcp-unit-tcp-monitor-syn-103-ghi", {'), 'must instantiate TcpMonitor');
  });

  it('emits the host db.example.com as request.hostname with the port', () => {
    const output = generateTcpMonitorCode(tcpFixture, { withAlertChannels: false });
    assert.ok(output.includes('hostname: "db.example.com"'), 'host must map to request.hostname');
    assert.ok(output.includes('port: 5432'), 'port must appear in the request');
  });

  it('derives maxResponseTime and degradedResponseTime from the responseTime assertion', () => {
    const output = generateTcpMonitorCode(tcpFixture, { withAlertChannels: false });
    assert.ok(output.includes('maxResponseTime: 2000'), 'responseTime lessThan 2000 must map to maxResponseTime');
    assert.ok(output.includes('degradedResponseTime: 1600'), 'degraded must be floor(max * 0.8)');
  });

  it('appends the migration_check_id traceability tag and preserves live activation', () => {
    const output = generateTcpMonitorCode(tcpFixture, { withAlertChannels: false });
    assert.ok(output.includes('migration_check_id:syn-103-ghi'), 'traceability tag must carry the public_id');
    assert.ok(output.includes('activated: true,'), 'live status must map to activated: true');
  });

  it('does not emit alertChannels in inline mode', () => {
    const output = generateTcpMonitorCode(tcpFixture, { withAlertChannels: false });
    assert.ok(!output.includes('alertChannels'), 'inline mode must not reference alertChannels');
  });
});

describe('generateDnsMonitorCode: inline mode baseline', () => {
  it('emits a DnsMonitor constructor call with the derived logical id', () => {
    const output = generateDnsMonitorCode(dnsFixture, { withAlertChannels: false });
    assert.ok(output.includes('new DnsMonitor("dns-unit-dns-monitor-syn-104-jkl", {'), 'must instantiate DnsMonitor');
  });

  it('emits the host as request.query with the hardcoded A record type', () => {
    const output = generateDnsMonitorCode(dnsFixture, { withAlertChannels: false });
    assert.ok(output.includes('query: "mail.example.net"'), 'host must map to request.query');
    assert.ok(output.includes('recordType: "A"'), 'recordType must be hardcoded to A');
  });

  it('converts the recordSome is assertion to DnsAssertionBuilder.textAnswer().contains()', () => {
    const output = generateDnsMonitorCode(dnsFixture, { withAlertChannels: false });
    assert.ok(
      output.includes('DnsAssertionBuilder.textAnswer().contains("192.0.2.10")'),
      'recordSome is must become a textAnswer contains assertion'
    );
  });

  it('appends the migration_check_id traceability tag and preserves live activation', () => {
    const output = generateDnsMonitorCode(dnsFixture, { withAlertChannels: false });
    assert.ok(output.includes('migration_check_id:syn-104-jkl'), 'traceability tag must carry the public_id');
    assert.ok(output.includes('activated: true,'), 'live status must map to activated: true');
  });

  it('does not emit alertChannels in inline mode', () => {
    const output = generateDnsMonitorCode(dnsFixture, { withAlertChannels: false });
    assert.ok(!output.includes('alertChannels'), 'inline mode must not reference alertChannels');
  });
});

/**
 * tcp/dns logical IDs must carry the Datadog public_id tail so
 * two same-name monitors never collapse to one ID. tcp/dns must
 * route public locations through the shared normalizePublicChecklyLocations and
 * therefore inherit its Set dedup; the local cleanPublicLocations forks are gone.
 * the standalone tcp/dns mapping CSVs must carry the same uniqueLogicalId as
 * the emit site, so the CSV and the construct can never drift. Variant inputs are
 * in-test spread-clones with synthetic-only overrides; no fixture JSON is edited
 *.
 */
describe('step 04b logical-id and CSV parity (tcp)', () => {
  it('derives the logical id from the shared helper (prefix, name slug, public_id)', () => {
    const output = generateTcpMonitorCode(tcpFixture, { withAlertChannels: false });
    const expected = uniqueLogicalId('tcp', tcpFixture.name, tcpFixture.public_id);
    assert.equal(expected, 'tcp-unit-tcp-monitor-syn-103-ghi', 'sanity: helper produces the pinned id');
    assert.ok(output.includes(`new TcpMonitor("${expected}", {`), 'emitted id must equal the shared-helper output');
  });

  it('same-name tcp tests differing only in public_id emit distinct logical ids', () => {
    const a = structuredClone(tcpFixture);
    const b = structuredClone(tcpFixture);
    a.public_id = 'syn-303-aaa';
    b.public_id = 'syn-303-bbb';
    const idA = generateTcpMonitorCode(a, { withAlertChannels: false }).match(/new TcpMonitor\("([^"]+)"/)?.[1];
    const idB = generateTcpMonitorCode(b, { withAlertChannels: false }).match(/new TcpMonitor\("([^"]+)"/)?.[1];
    assert.ok(idA && idB, 'both monitors must carry a logical id');
    assert.notEqual(idA, idB, 'same-name tcp monitors must not collapse to one logical id');
  });

  it('dedups public locations through the shared normalizer', () => {
    const fixture = structuredClone(tcpFixture);
    fixture.locations = ['aws:us-east-1', 'us-east-1'];
    const output = generateTcpMonitorCode(fixture, { withAlertChannels: false });
    assert.ok(output.includes('locations: ["us-east-1"]'), 'aws:us-east-1 and us-east-1 must dedup to a single entry');
  });

  it('standalone tcp mapping CSV logical id equals the emit-site uniqueLogicalId', () => {
    const csv = buildMappingCsvForTcp([tcpFixture]);
    const row = csv.trim().split('\n')[1];
    const checklyLogicalId = row.split(',')[2];
    const expected = uniqueLogicalId('tcp', tcpFixture.name, tcpFixture.public_id);
    assert.equal(checklyLogicalId, expected, 'CSV checkly_logical_id must match the construct logical id');
  });
});

describe('step 04c logical-id and CSV parity (dns)', () => {
  it('derives the logical id from the shared helper (prefix, name slug, public_id)', () => {
    const output = generateDnsMonitorCode(dnsFixture, { withAlertChannels: false });
    const expected = uniqueLogicalId('dns', dnsFixture.name, dnsFixture.public_id);
    assert.equal(expected, 'dns-unit-dns-monitor-syn-104-jkl', 'sanity: helper produces the pinned id');
    assert.ok(output.includes(`new DnsMonitor("${expected}", {`), 'emitted id must equal the shared-helper output');
  });

  it('same-name dns tests differing only in public_id emit distinct logical ids', () => {
    const a = structuredClone(dnsFixture);
    const b = structuredClone(dnsFixture);
    a.public_id = 'syn-304-aaa';
    b.public_id = 'syn-304-bbb';
    const idA = generateDnsMonitorCode(a, { withAlertChannels: false }).match(/new DnsMonitor\("([^"]+)"/)?.[1];
    const idB = generateDnsMonitorCode(b, { withAlertChannels: false }).match(/new DnsMonitor\("([^"]+)"/)?.[1];
    assert.ok(idA && idB, 'both monitors must carry a logical id');
    assert.notEqual(idA, idB, 'same-name dns monitors must not collapse to one logical id');
  });

  it('dedups public locations through the shared normalizer', () => {
    const fixture = structuredClone(dnsFixture);
    fixture.locations = ['aws:us-east-1', 'us-east-1'];
    const output = generateDnsMonitorCode(fixture, { withAlertChannels: false });
    assert.ok(output.includes('locations: ["us-east-1"]'), 'aws:us-east-1 and us-east-1 must dedup to a single entry');
  });

  it('standalone dns mapping CSV logical id equals the emit-site uniqueLogicalId', () => {
    const csv = buildMappingCsvForDns([dnsFixture]);
    const row = csv.trim().split('\n')[1];
    const checklyLogicalId = row.split(',')[2];
    const expected = uniqueLogicalId('dns', dnsFixture.name, dnsFixture.public_id);
    assert.equal(checklyLogicalId, expected, 'CSV checkly_logical_id must match the construct logical id');
  });
});
