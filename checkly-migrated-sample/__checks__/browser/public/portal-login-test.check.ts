/**
 * Sample check - dummy data
 */
import {
  BrowserCheck,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";
import { alertChannels } from "../../../../default_resources/alertChannels";
import { public_locations_group } from "../../groups/public/group.check";

new BrowserCheck("browser-portal-login-test", {
  name: "Portal Login Test",
  tags: ["region:eastus2","platform:portal","applicationname:portal","env:prod","team:frontend", "public"],
  code: {
    entrypoint: "../../../tests/browser/public/portal-login-test.spec.ts",
  },
  frequency: Frequency.EVERY_10M,
  locations: ["us-east-1"],
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: 2,
    maxRetries: 1,
    maxDurationSeconds: 600,
    sameRegion: true,
  }),
  runParallel: true,
  alertChannels,
  group: public_locations_group,
});
