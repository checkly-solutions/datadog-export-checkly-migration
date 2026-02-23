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

new BrowserCheck("browser-cloud-status-page-check", {
  name: "Cloud Status Page Check",
  tags: ["region:eastus2","platform:infra","applicationname:monitoring","env:prod","team:infra", "private"],
  code: {
    entrypoint: "../../../tests/browser/private/cloud-status-page-check.spec.ts",
  },
  frequency: Frequency.EVERY_10M,
  locations: [],
  privateLocations: ["example-aks-eastus2"],
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  runParallel: true,
  alertChannels,
  group: private_locations_group,
});
