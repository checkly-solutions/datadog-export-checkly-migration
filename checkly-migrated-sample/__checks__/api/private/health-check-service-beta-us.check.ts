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

new ApiCheck("api-health-check-service-beta-us", {
  name: "Service Beta - [prod] US actuator health",
  tags: ["applicationname:Service Beta","region:eastus2","env:prod","team:backend", "private"],
  request: {
    url: "http://10.0.1.100:8090/service-beta/actuator/health",
    method: "GET",
    assertions: [
      AssertionBuilder.statusCode().equals(200),
    ],
  },
  frequency: Frequency.EVERY_10M,
  locations: [],
  privateLocations: ["example-aks-eastus2"],
  degradedResponseTime: 5000,
  maxResponseTime: 15000,
  activated: false,
  muted: false,
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: 10,
    maxRetries: 2,
    maxDurationSeconds: 600,
    sameRegion: true,
  }),
  alertChannels,
  group: private_locations_group,
});
