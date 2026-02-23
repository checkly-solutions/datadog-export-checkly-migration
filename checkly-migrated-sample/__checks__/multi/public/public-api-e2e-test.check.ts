/**
 * Sample check - dummy data
 */
import {
  Frequency,
  MultiStepCheck,
  RetryStrategyBuilder,
} from "checkly/constructs";
import { alertChannels } from "../../../../default_resources/alertChannels";
import { public_locations_group } from "../../groups/public/group.check";

new MultiStepCheck("multi-public-api-e2e-test", {
  name: "Public API E2E Test",
  tags: ["environment:prod","env:prod","applicationname:public_api", "public"],
  code: {
    entrypoint: "../../../tests/multi/public/public-api-e2e-test.spec.ts",
  },
  frequency: Frequency.EVERY_10M,
  locations: ["us-east-1"],
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: 10,
    maxRetries: 2,
    maxDurationSeconds: 600,
    sameRegion: true,
  }),
  runParallel: true,
  alertChannels,
  group: public_locations_group,
});
