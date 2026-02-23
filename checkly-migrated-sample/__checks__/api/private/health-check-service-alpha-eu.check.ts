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

new ApiCheck("api-health-check-service-alpha-eu", {
  name: "Service Alpha - [prod] EU API health check",
  tags: ["operation:servlet.request","resource_name:GET /health","applicationname:Service Alpha","region:westeurope","env:prod","team:platform", "private"],
  request: {
    url: "http://service-alpha-prod-eu.internal.example.net/api/v1/health",
    method: "GET",
    assertions: [
      AssertionBuilder.statusCode().equals(200),
      AssertionBuilder.headers("content-type").equals("application/json"),
    ],
  },
  frequency: Frequency.EVERY_5M,
  locations: [],
  privateLocations: ["example-aks-westeurope"],
  degradedResponseTime: 10000,
  maxResponseTime: 30000,
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  alertChannels,
  group: private_locations_group,
});
