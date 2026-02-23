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

new ApiCheck("api-cloud-provider-status-page", {
  name: "Cloud Provider - Status Page Check",
  tags: ["monitoredby:platform","region:eastus2","env:prod","team:infra", "public"],
  request: {
    url: "https://status.cloud-provider.example.com/api/v2/status.json",
    method: "GET",
    assertions: [
      AssertionBuilder.statusCode().equals(200),
    ],
  },
  frequency: Frequency.EVERY_5M,
  locations: ["us-east-1"],
  degradedResponseTime: 10000,
  maxResponseTime: 30000,
  activated: false,
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
