/**
 * Migrated from Datadog Synthetic: syn-002-def
 */
import {
  ApiCheck,
  AssertionBuilder,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new ApiCheck("api-synthetic-private-api-syn-002-def", {
  name: "Synthetic Private API",
  tags: ["env:synthetic","team:example","migration_check_id:syn-002-def"],
  request: {
    url: "https://internal.example.org/health",
    method: "POST",
    headers: [
      { key: "Content-Type", value: "application/x-www-form-urlencoded" },
    ],
    body: "grant_type=client_credentials",
    bodyType: "FORM",
    assertions: [
      AssertionBuilder.statusCode().equals(200),
    ],
  },
  frequency: Frequency.EVERY_15M,
  locations: [],
  privateLocations: ["example-private"],
  degradedResponseTime: 10000,
  maxResponseTime: 30000,
  activated: false, // Preserves paused status from Datadog (status !== 'live' -> activated: false)
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
});
