/**
 * Sample check - dummy data
 */
import {
  ApiCheck,
  AssertionBuilder,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";
import { alertChannels } from "../../../../default_resources/alertChannels";
import { private_locations_group } from "../../groups/private/group.check";

new ApiCheck("api-platform-status-page-check", {
  name: "Platform - Status Page Health Check",
  tags: ["monitoredby:platform","region:eastus2","env:prod","team:infra", "private"],
  request: {
    url: "https://status.internal.example.net/api/v2/status.json",
    method: "GET",
    assertions: [
      AssertionBuilder.statusCode().equals(200),
    ],
  },
  frequency: Frequency.EVERY_5M,
  locations: [],
  privateLocations: ["example-aks-eastus2"],
  degradedResponseTime: 10000,
  maxResponseTime: 30000,
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  alertChannels,
  group: private_locations_group,
});
