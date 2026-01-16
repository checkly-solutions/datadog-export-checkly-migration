import { CheckGroupV2 } from "checkly/constructs";
import { alertChannels } from "./alertChannels";

/**
 * Check Groups
 *
 * Groups organize checks and can apply shared settings like alert channels.
 * Checks are automatically assigned to the appropriate group based on
 * whether they use public or private locations.
 */

export const private_locations_group = new CheckGroupV2(
  `datadog-migrated-private_checks`,
  {
    name: `Datadog Migrated Private Checks`,
    activated: false,
    tags: [`migrated`, "cli", "deactivated", "private"],
    alertChannels,
  }
);

export const public_locations_group = new CheckGroupV2(
  `datadog-migrated-public_checks`,
  {
    name: `Datadog Migrated Public Checks`,
    activated: false,
    tags: [`migrated`, "cli", "deactivated", "public"],
    alertChannels,
  }
);
