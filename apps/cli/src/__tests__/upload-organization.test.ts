import { expect, test } from "bun:test";
import { getDefaultUploadOrganizationId } from "../lib/upload-organization.js";

test("prefers the personal workspace when it is among multiple memberships", () => {
	expect(
		getDefaultUploadOrganizationId([{ id: "team" }, { id: "user" }], "user"),
	).toBe("user");
});

test("uses a sole legacy workspace whose ID differs from the user's ID", () => {
	expect(getDefaultUploadOrganizationId([{ id: "legacy" }], "user")).toBe(
		"legacy",
	);
});

test("requires a choice for multiple workspaces without a personal default", () => {
	expect(
		getDefaultUploadOrganizationId(
			[{ id: "team-a" }, { id: "team-b" }],
			"user",
		),
	).toBeUndefined();
});

test("leaves resolution to the server when no memberships were saved", () => {
	expect(getDefaultUploadOrganizationId([], undefined)).toBeUndefined();
});
