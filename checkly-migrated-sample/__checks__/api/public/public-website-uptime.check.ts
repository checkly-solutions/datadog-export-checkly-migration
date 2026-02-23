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

new ApiCheck("api-public-website-uptime", {
  name: "Public Website - Uptime Monitor",
  tags: ["monitoredby:platform","env:prod","team:frontend", "public"],
  request: {
    url: "https://www.example.com/",
    method: "GET",
    assertions: [
      AssertionBuilder.statusCode().equals(200),
    ],
  },
  frequency: Frequency.EVERY_10M,
  locations: ["us-east-1", "eu-west-1"],
  degradedResponseTime: 5000,
  maxResponseTime: 15000,
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  alertChannels,
  group: public_locations_group,
});
