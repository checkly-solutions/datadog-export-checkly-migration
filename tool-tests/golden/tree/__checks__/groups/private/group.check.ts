import { CheckGroupV2 } from "checkly/constructs";

export const private_locations_group = new CheckGroupV2(
  "datadog-migrated-private-checks",
  {
    name: "Datadog Migrated Private Checks",
    activated: false,
    tags: ["migrated", "private"],
  }
);
