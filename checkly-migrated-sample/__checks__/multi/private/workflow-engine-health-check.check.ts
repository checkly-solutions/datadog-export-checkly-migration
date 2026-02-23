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

new MultiStepCheck("multi-workflow-engine-health-check", {
  name: "Workflow Engine Health Check",
  tags: ["environment:prod","region:eastus2,westeurope","env:prod","applicationname:workflow_engine", "private"],
  code: {
    entrypoint: "../../../tests/multi/private/workflow-engine-health-check.spec.ts",
  },
  frequency: Frequency.EVERY_5M,
  locations: [],
  privateLocations: ["example-aks-eastus2"],
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  runParallel: true,
  alertChannels,
  group: private_locations_group,
});
