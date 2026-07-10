/**
 * Migrated from Datadog Synthetic: syn-005-mno
 */
import {
  Frequency,
  MultiStepCheck,
  RetryStrategyBuilder,
} from "checkly/constructs";

new MultiStepCheck("multi-synthetic-login-flow-syn-005-mno", {
  name: "Synthetic Login Flow",
  tags: ["env:synthetic","team:example","migration_check_id:syn-005-mno"],
  code: {
    entrypoint: "../../../tests/multi/public/synthetic-login-flow-syn-005-mno.spec.ts",
  },
  frequency: Frequency.EVERY_15M,
  locations: ["us-east-1"],
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: 1,
    maxRetries: 1,
    maxDurationSeconds: 600,
    sameRegion: true,
  }),
  runParallel: true,
});
