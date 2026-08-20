/**
 * Migrated from Datadog Synthetic: syn-006-pqr
 */
import {
  BrowserCheck,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new BrowserCheck("browser-synthetic-browser-flow-syn-006-pqr", {
  name: "Synthetic Browser Flow",
  tags: ["env:synthetic","team:example","migration_check_id:syn-006-pqr","reviewMultiSelector"],
  code: {
    entrypoint: "../../../tests/browser/public/synthetic-browser-flow-syn-006-pqr.spec.ts",
  },
  frequency: Frequency.EVERY_15M,
  locations: ["us-east-1"],
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  runParallel: true,
});
