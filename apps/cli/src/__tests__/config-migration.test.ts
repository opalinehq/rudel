import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials } from "../lib/credentials.js";
import { getConfigPathInfo } from "../lib/local-state.js";

let fixtureHome: string;

beforeAll(async () => {
	fixtureHome = await mkdtemp(join(tmpdir(), "opaline-config-migration-"));
});

afterAll(async () => {
	await rm(fixtureHome, { recursive: true, force: true });
});

describe("Rudel config compatibility", () => {
	test("reads the real Rudel credential path without requiring login", async () => {
		const info = getConfigPathInfo({}, fixtureHome);
		const credentialsPath = join(info.directory, "credentials.json");
		await mkdir(info.directory, { recursive: true, mode: 0o700 });
		await writeFile(
			credentialsPath,
			JSON.stringify({
				token: "fixture-token",
				apiBaseUrl: "https://app.rudel.ai",
				authType: "api-key",
				apiKeyId: "fixture-key-id",
			}),
			{ mode: 0o600 },
		);

		expect(info.directory).toBe(join(fixtureHome, ".rudel"));
		expect(info.source).toBe("rudel-default");
		expect(loadCredentials("read-only", info.directory)).toEqual({
			token: "fixture-token",
			apiBaseUrl: "https://opaline.so",
			authType: "api-key",
			apiKeyId: "fixture-key-id",
			user: undefined,
			organizations: undefined,
		});
	});

	test("preserves a custom credential API base", async () => {
		const customDirectory = join(fixtureHome, "custom");
		await mkdir(customDirectory, { recursive: true, mode: 0o700 });
		await writeFile(
			join(customDirectory, "credentials.json"),
			JSON.stringify({
				token: "fixture-token",
				apiBaseUrl: "https://opaline.internal.example/base",
				authType: "api-key",
			}),
			{ mode: 0o600 },
		);

		expect(loadCredentials("read-only", customDirectory)?.apiBaseUrl).toBe(
			"https://opaline.internal.example/base",
		);
	});

	test("ignores the dead Gazed config path", async () => {
		const gazedDirectory = join(fixtureHome, "gazed-only", ".config", "gazed");
		await mkdir(gazedDirectory, { recursive: true });
		await writeFile(
			join(gazedDirectory, "config.json"),
			JSON.stringify({
				apiKey: "must-not-be-read",
				endpoint: "https://example.invalid/rpc",
			}),
		);

		const home = join(fixtureHome, "gazed-only");
		const info = getConfigPathInfo({}, home);
		expect(loadCredentials("read-only", info.directory)).toBeNull();
	});
});
