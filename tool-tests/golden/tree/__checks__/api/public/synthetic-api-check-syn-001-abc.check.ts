/**
 * Migrated from Datadog Synthetic: syn-001-abc
 */
import {
  ApiCheck,
  AssertionBuilder,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new ApiCheck("api-synthetic-api-check-syn-001-abc", {
  name: "Synthetic API Check",
  tags: ["env:synthetic","team:example","migration_check_id:syn-001-abc","priority:P3"],
  request: {
    url: "https://api.example.com/v1/status",
    method: "GET",
    headers: [
      { key: "Accept", value: "application/json" },
    ],
    assertions: [
      AssertionBuilder.statusCode().equals(200),
      AssertionBuilder.textBody().contains("ok"),
    ],
  },
  frequency: Frequency.EVERY_5M,
  locations: ["us-east-1"],
  degradedResponseTime: 10000,
  maxResponseTime: 30000,
  activated: true, // Preserves paused status from Datadog (status !== 'live' -> activated: false)
  muted: false,
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: 1,
    maxRetries: 1,
    maxDurationSeconds: 600,
    sameRegion: true,
  }),
});
