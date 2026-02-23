/**
 * Sample check - dummy data
 */
import {
  BrowserCheck,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";
import { alertChannels } from "../../../../default_resources/alertChannels";
import { private_locations_group } from "../../groups/private/group.check";

new BrowserCheck("browser-dashboard-login-flow", {
  name: "Dashboard Login Flow",
  tags: ["region:eastus2","platform:internal","applicationname:dashboard","env:prod","team:frontend", "private"],
  code: {
    entrypoint: "../../../tests/browser/private/dashboard-login-flow.spec.ts",
  },
  frequency: Frequency.EVERY_5M,
  locations: [],
  privateLocations: ["example-aks-eastus2"],
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
  group: private_locations_group,
});
