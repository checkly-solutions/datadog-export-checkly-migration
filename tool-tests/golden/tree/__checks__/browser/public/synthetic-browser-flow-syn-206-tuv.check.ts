/**
 * Migrated from Datadog Synthetic: syn-206-tuv
 */
import {
  BrowserCheck,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new BrowserCheck("browser-synthetic-browser-flow-syn-206-tuv", {
  name: "Synthetic Browser Flow",
  tags: ["env:synthetic","team:example","migration_check_id:syn-206-tuv","reviewMigrationFlag"],
  code: {
    entrypoint: "../../../tests/browser/public/synthetic-browser-flow-syn-206-tuv.spec.ts",
  },
  frequency: Frequency.EVERY_15M,
  locations: ["us-east-1"],
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  runParallel: true,
});
