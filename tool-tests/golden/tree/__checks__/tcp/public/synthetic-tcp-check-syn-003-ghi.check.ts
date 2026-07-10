/**
 * Migrated from Datadog Synthetic: syn-003-ghi
 */
import {
  TcpMonitor,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new TcpMonitor("tcp-synthetic-tcp-check-syn-003-ghi", {
  name: "Synthetic TCP Check",
  tags: ["env:synthetic","migration_check_id:syn-003-ghi"],
  request: {
    hostname: "db.example.com",
    port: 5432,
  },
  frequency: Frequency.EVERY_5M,
  locations: ["us-east-1"],
  degradedResponseTime: 1600,
  maxResponseTime: 2000,
  activated: true, // Preserves paused status from Datadog (status !== 'live' -> activated: false)
  muted: false,
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    maxRetries: 1,
    baseBackoffSeconds: 1,
  }),
});
