/**
 * Migrated from Datadog Synthetic: syn-004-jkl
 */
import {
  DnsMonitor,
  DnsAssertionBuilder,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new DnsMonitor("dns-synthetic-dns-check-syn-004-jkl", {
  name: "Synthetic DNS Check",
  tags: ["env:synthetic","migration_check_id:syn-004-jkl"],
  request: {
    recordType: "A",
    query: "mail.example.net",
    assertions: [
      DnsAssertionBuilder.textAnswer().contains("192.0.2.10"),
    ],
  },
  frequency: Frequency.EVERY_15M,
  locations: ["us-east-1"],
  degradedResponseTime: 800,
  maxResponseTime: 1000,
  activated: true, // Preserves paused status from Datadog (status !== 'live' -> activated: false)
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
});
