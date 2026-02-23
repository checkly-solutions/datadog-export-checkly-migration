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
import { public_locations_group } from "../../groups/public/group.check";

new ApiCheck("api-external-api-gateway-health", {
  name: "External API Gateway - Health Check",
  tags: ["monitoredby:platform","region:eastus2","env:prod","team:platform", "public"],
  request: {
    url: "https://api.example.com/gateway/health",
    method: "GET",
    assertions: [
      AssertionBuilder.statusCode().equals(200),
      AssertionBuilder.headers("content-type").equals("application/json"),
    ],
  },
  frequency: Frequency.EVERY_5M,
  locations: ["us-east-1"],
  degradedResponseTime: 10000,
  maxResponseTime: 30000,
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: 10,
    maxRetries: 2,
    maxDurationSeconds: 600,
    sameRegion: true,
  }),
  alertChannels,
  group: public_locations_group,
});
