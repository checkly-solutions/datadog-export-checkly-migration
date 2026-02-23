import { EmailAlertChannel } from "checkly/constructs";

/**
 * Default Alert Channels
 *
 * Add your alert channels here and include them in the alertChannels array below.
 * These will be applied to all checks when running `npm run add:defaults`.
 *
 * Supported channel types:
 * - EmailAlertChannel
 * - SlackAlertChannel
 * - WebhookAlertChannel
 * - OpsgenieAlertChannel
 * - PagerdutyAlertChannel
 * - MSTeamsAlertChannel
 *
//  * Example:
//  *   import { SlackAlertChannel } from "checkly/constructs";
//  *   export const slackChannel = new SlackAlertChannel("slack-channel-1", {
//  *     url: "https://hooks.slack.com/services/xxx/yyy/zzz",
//  *   });
//  */

export const emailChannel = new EmailAlertChannel("email-channel-1", {
  address: "alerts@acme.com",
});

// Add additional alert channels above and include them in this array
export const alertChannels = [emailChannel];
