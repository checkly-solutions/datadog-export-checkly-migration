import { CheckGroupV2 } from "checkly/constructs";

export const private_locations_group = new CheckGroupV2(
  "sample-migrated-private-checks",
  {
    name: "Sample Migrated Private Checks",
    activated: false,
    tags: ["migrated", "private", "sample"],
  }
);
