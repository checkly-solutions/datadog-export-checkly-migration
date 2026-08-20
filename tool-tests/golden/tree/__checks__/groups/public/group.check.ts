import { CheckGroupV2 } from "checkly/constructs";

export const public_locations_group = new CheckGroupV2(
  "datadog-migrated-public-checks",
  {
    name: "Datadog Migrated Public Checks",
    activated: false,
    tags: ["migrated", "public"],
  }
);
