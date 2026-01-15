Matching Datadog API to Checkly API Check attributes

tags = tags
public_id = logicalId
name = name
assertions = assertions w/ AssertionBuilder
method = method
url = url
assertions[type=responseTime].target = maxResponseTime (extract from responseTime assertion, value is in ms)
retry = retryStrategy
locations != locations any locations that start w/ pl: in datadog belong to privateLocations array and not locations array.

Note: min_failure_duration is NOT maxResponseTime. It's the minimum time a test must fail before alerting (alerting config, not response time threshold).


```typescript
import {
  AlertEscalationBuilder,
  ApiCheck,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new ApiCheck(`${logicalId}`, {
  name: "Example API Check",
  request: {
    url: "https://api.example.com/v1/products",
    method: "GET",
    ipFamily: "IPv4",
  },
  setupScript: {
    entrypoint: "./setup-script.ts",
  },
  tearDownScript: {
    entrypoint: "./teardown-script.ts",
  },
  assertions: [
      AssertionBuilder.statusCode().equals(200),
      AssertionBuilder.jsonBody("$.users.length").greaterThan(0),
      AssertionBuilder.responseTime().lessThan(1000),
    ],
  degradedResponseTime: 5000,
  maxResponseTime: 20000,
  activated: true,
  muted: false,
  shouldFail: false,
  locations: ["eu-central-1", "eu-west-2"],
  frequency: Frequency.EVERY_5M,
  alertEscalationPolicy: AlertEscalationBuilder.runBasedEscalation(
    1,
    {
      amount: 0,
      interval: 5,
    },
    {
      enabled: false,
      percentage: 10,
    }
  ),
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: 60,
    maxRetries: 2,
    maxDurationSeconds: 600,
    sameRegion: true,
  }),
  runParallel: true,
});

```