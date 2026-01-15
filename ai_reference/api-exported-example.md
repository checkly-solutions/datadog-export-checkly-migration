# Datadog API Test Export Example

Example JSON structure from Datadog API synthetic test export.

```json
{
  "exportedAt": "2025-01-05T14:40:18.629Z",
  "site": "datadoghq.com",
  "count": 1,
  "tests": [
    {
      "public_id": "abc-123-xyz",
      "name": "Product API Health Check",
      "status": "live",
      "type": "api",
      "subtype": "http",
      "tags": [
        "appid:12345",
        "bu:engineering",
        "env:prod",
        "team:platform"
      ],
      "created_at": "2024-01-15T09:00:00.000000+00:00",
      "modified_at": "2025-01-05T12:00:00.000000+00:00",
      "config": {
        "assertions": [
          {
            "operator": "lessThan",
            "type": "responseTime",
            "target": 10000
          },
          {
            "operator": "is",
            "type": "statusCode",
            "target": 200
          }
        ],
        "request": {
          "method": "GET",
          "url": "https://api.example.com/v1/health"
        }
      },
      "message": "@oncall@example.com @webhook-slack-alerts\n\n{{#is_alert}}\nAlert: API check failed.\nStatus: {{synthetics.attributes.result.status}}\nTime: {{local_time 'last_triggered_at' 'UTC'}}\nFailure: {{synthetics.attributes.result.failure.message}}\n{{/is_alert}}\n{{#is_recovery}}\nRecovered: API check is healthy.\n{{/is_recovery}}",
      "options": {
        "httpVersion": "http1",
        "min_failure_duration": 900,
        "min_location_failed": 2,
        "monitor_options": {
          "renotify_interval": 30,
          "escalation_message": "",
          "renotify_occurrences": 0,
          "notification_preset_name": "hide_all"
        },
        "monitor_priority": 2,
        "retry": {
          "count": 3,
          "interval": 10000
        },
        "tick_every": 900
      },
      "locations": [
        "aws:us-east-1",
        "aws:eu-west-1"
      ],
      "monitor_id": 12345678,
      "creator": {
        "name": "Jane Doe",
        "handle": "jane.doe@example.com",
        "email": "jane.doe@example.com"
      }
    }
  ]
}
```

## Key Fields

| Field | Description |
|-------|-------------|
| `public_id` | Unique test identifier (becomes `logicalId` in Checkly) |
| `name` | Test display name |
| `status` | `live` or `paused` |
| `type` | `api` or `browser` |
| `subtype` | `http`, `ssl`, `dns`, `tcp`, or `multi` |
| `tags` | Array of key:value tag strings |
| `config.assertions` | Array of assertions to validate |
| `config.request` | HTTP request configuration |
| `options.retry` | Retry configuration (count and interval in ms) |
| `options.tick_every` | Check frequency in seconds |
| `locations` | Array of locations (`aws:*` for public, `pl:*` for private) |
