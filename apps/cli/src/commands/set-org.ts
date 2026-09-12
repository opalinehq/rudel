import * as p from "@clack/prompts";
import { buildCommand } from "@stricli/core";
import { createApiClient } from "../lib/api-client.js";
import { PRODUCTION_API_BASE } from "../lib/api-target.js";
import { loadCredentials } from "../lib/credentials.js";
import { getProjectOrgId, setProjectOrgId } from "../lib/project-config.js";

async function runSetOrg(): Promise<undefined | Error> {
	p.intro("opaline set-org");

	const credentials = loadCredentials();
	if (!credentials) {
		p.outro("Run `opaline login` first.");
		return new Error("Not authenticated.");
	}

	let orgs: { id: string; name: string; slug: string }[];
	if (credentials.authType === "api-key") {
		orgs = credentials.organizations ?? [];
	} else {
		const client = createApiClient(credentials);
		try {
			orgs = await client.listMyOrganizations();
		} catch {
			return new Error("Failed to fetch organizations. Check your connection.");
		}
	}

	if (orgs.length === 0) {
		p.outro(`Create one at ${PRODUCTION_API_BASE} first.`);
		return new Error("No organizations found.");
	}

	const cwd = process.cwd();
	const currentOrgId = await getProjectOrgId(cwd);

	const selected = await p.select({
		message: "Select an organization for this repository",
		options: orgs.map((org) => ({
			value: org.id,
			label: org.name,
			hint: org.id === currentOrgId ? `${org.slug} (current)` : org.slug,
		})),
		initialValue: currentOrgId ?? undefined,
	});

	if (p.isCancel(selected)) {
		p.cancel("Cancelled.");
		return;
	}

	await setProjectOrgId(cwd, selected);
	const selectedOrg = orgs.find((o) => o.id === selected);
	p.log.success(`Organization set to: ${selectedOrg?.name}`);
	p.outro("Done!");
}

export const setOrgCommand = buildCommand({
	loader: async () => ({ default: runSetOrg }),
	parameters: {},
	docs: {
		brief: "Set the organization for the current repository",
	},
});
