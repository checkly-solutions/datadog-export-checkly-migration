/**
 * Sample check - dummy data
 */
import {
  Frequency,
  MultiStepCheck,
  RetryStrategyBuilder,
} from "checkly/constructs";
import { alertChannels } from "../../../../default_resources/alertChannels";
import { private_locations_group } from "../../groups/private/group.check";

new MultiStepCheck("multi-auth-token-generation", {
  name: "Auth Token Generation Test",
  tags: ["environment:prod","region:eastus2","env:prod","applicationname:auth_service", "private"],
  code: {
    entrypoint: "../../../tests/multi/private/auth-token-generation.spec.ts",
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
