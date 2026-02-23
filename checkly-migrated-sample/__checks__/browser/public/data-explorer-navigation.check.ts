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

new BrowserCheck("browser-data-explorer-navigation", {
  name: "Data Explorer Navigation",
  tags: ["platform:analytics","applicationname:data-explorer","env:prod","team:analytics", "public"],
  code: {
    entrypoint: "../../../tests/browser/public/data-explorer-navigation.spec.ts",
  },
  frequency: Frequency.EVERY_10M,
  locations: ["us-east-1", "eu-west-1"],
  activated: false,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  runParallel: true,
  alertChannels,
  group: public_locations_group,
});
