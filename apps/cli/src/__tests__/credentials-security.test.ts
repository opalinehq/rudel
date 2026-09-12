import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Credentials,
	loadCredentials,
	saveCredentials,
} from "../lib/credentials.js";

const OLD_TOKEN = "old-private-token";
const NEW_TOKEN = "new-private-token";
const NEW_CREDENTIALS: Credentials = {
	token: NEW_TOKEN,
	apiBaseUrl: "https://api.rudel.test",
};
const PERMISSION_FAILURE_ACTIONS: readonly ("load" | "save")[] = [
	"load",
	"save",
];
const PERMISSION_POLICY_SCRIPT = `
import { mock } from "bun:test";
import * as actualFs from "node:fs";

const configDir = process.env.RUDEL_CONFIG_DIR;
if (!configDir) throw new Error("RUDEL_CONFIG_DIR is required");

const platform = process.argv[1];
const action = process.argv[2];
const credentialsPath = actualFs.realpathSync(configDir) + "/credentials.json";

mock.module("node:fs", () => ({
	chmodSync(path, mode) {
		if (platform === "win32" || String(path) === credentialsPath) {
			throw new Error("simulated chmod failure");
		}
		actualFs.chmodSync(path, mode);
	},
	existsSync: actualFs.existsSync,
	mkdirSync: actualFs.mkdirSync,
	readFileSync: actualFs.readFileSync,
	renameSync: actualFs.renameSync,
	rmSync: actualFs.rmSync,
	statSync: actualFs.statSync,
	writeFileSync: actualFs.writeFileSync,
}));

Object.defineProperty(process, "platform", { value: platform });
const { loadCredentials, saveCredentials } = await import(
	"./apps/cli/src/lib/credentials.ts"
);

if (platform === "win32") {
	saveCredentials({
		token: "new-private-token",
		apiBaseUrl: "https://api.rudel.test",
	});
	const loaded = loadCredentials();
	if (loaded?.token !== "new-private-token") {
		throw new Error("Windows credential round trip failed");
	}
	process.stdout.write("ok");
} else {
	let blocked = false;
	try {
		if (action === "load") {
			loadCredentials();
		} else {
			saveCredentials({
				token: "new-private-token",
				apiBaseUrl: "https://api.rudel.test",
			});
		}
	} catch {
		blocked = true;
	}
	process.stdout.write(blocked ? "blocked" : "unexpected success");
}
`;

const tempRoot = mkdtempSync(join(tmpdir(), "rudel-credentials-security-"));

afterAll(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

test("repairs existing permissions and atomically replaces credentials", () => {
	const configDir = join(tempRoot, "save");
	const credentialsPath = preparePermissiveCredentials(configDir);
	const previousInode = statSync(credentialsPath).ino;

	withConfigDir(configDir, () => saveCredentials(NEW_CREDENTIALS));

	expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toEqual(
		NEW_CREDENTIALS,
	);
	expect(readdirSync(configDir)).toEqual(["credentials.json"]);
	if (process.platform !== "win32") {
		expect(permissions(configDir)).toBe(0o700);
		expect(permissions(credentialsPath)).toBe(0o600);
		expect(statSync(credentialsPath).ino).not.toBe(previousInode);
	}
});

test("canonicalizes the legacy production API base when saving credentials", () => {
	const configDir = join(tempRoot, "save-legacy-production-base");

	withConfigDir(configDir, () =>
		saveCredentials({
			token: NEW_TOKEN,
			apiBaseUrl: "https://app.rudel.ai/",
		}),
	);

	expect(
		JSON.parse(readFileSync(join(configDir, "credentials.json"), "utf8")),
	).toEqual({
		token: NEW_TOKEN,
		apiBaseUrl: "https://opaline.so",
	});
});

test("repairs existing permissions before loading credentials", () => {
	const configDir = join(tempRoot, "load");
	const credentialsPath = preparePermissiveCredentials(configDir);

	const credentials = withConfigDir(configDir, () => loadCredentials());

	expect(credentials?.token).toBe(OLD_TOKEN);
	if (process.platform !== "win32") {
		expect(permissions(configDir)).toBe(0o700);
		expect(permissions(credentialsPath)).toBe(0o600);
	}
});

test.each(PERMISSION_FAILURE_ACTIONS)(
	"%s fails closed when file permissions cannot be repaired",
	async (action) => {
		const configDir = join(tempRoot, `failure-${action}`);
		const credentialsPath = preparePermissiveCredentials(configDir);

		const result = await runPermissionPolicyScript("linux", action, configDir);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("blocked");
		expect(result.stderr).toBe("");
		expect(result.stdout).not.toContain(OLD_TOKEN);
		expect(result.stdout).not.toContain(NEW_TOKEN);
		expect(result.stderr).not.toContain(OLD_TOKEN);
		expect(result.stderr).not.toContain(NEW_TOKEN);
		expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toEqual({
			token: OLD_TOKEN,
			apiBaseUrl: "https://old.rudel.test",
		});
	},
);

test("uses account ACLs instead of unsupported POSIX modes on Windows", async () => {
	const configDir = join(tempRoot, "windows");
	const credentialsPath = preparePermissiveCredentials(configDir);

	const result = await runPermissionPolicyScript(
		"win32",
		"roundtrip",
		configDir,
	);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe("ok");
	expect(result.stderr).toBe("");
	expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toEqual(
		NEW_CREDENTIALS,
	);
});

function preparePermissiveCredentials(configDir: string): string {
	const credentialsPath = join(configDir, "credentials.json");
	mkdirSync(configDir, { recursive: true, mode: 0o755 });
	writeFileSync(
		credentialsPath,
		JSON.stringify({
			token: OLD_TOKEN,
			apiBaseUrl: "https://old.rudel.test",
		}),
		{ mode: 0o644 },
	);
	chmodSync(configDir, 0o755);
	chmodSync(credentialsPath, 0o644);
	return credentialsPath;
}

function withConfigDir<TResult>(
	configDir: string,
	action: () => TResult,
): TResult {
	const previousConfigDir = process.env.RUDEL_CONFIG_DIR;
	process.env.RUDEL_CONFIG_DIR = configDir;
	try {
		return action();
	} finally {
		if (previousConfigDir === undefined) {
			delete process.env.RUDEL_CONFIG_DIR;
		} else {
			process.env.RUDEL_CONFIG_DIR = previousConfigDir;
		}
	}
}

async function runPermissionPolicyScript(
	platform: string,
	action: string,
	configDir: string,
): Promise<ProcessResult> {
	const processHandle = Bun.spawn(
		[process.execPath, "-e", PERMISSION_POLICY_SCRIPT, platform, action],
		{
			cwd: join(import.meta.dir, "../../../.."),
			env: { ...process.env, RUDEL_CONFIG_DIR: configDir },
			stderr: "pipe",
			stdout: "pipe",
		},
	);
	const [exitCode, stderr, stdout] = await Promise.all([
		processHandle.exited,
		new Response(processHandle.stderr).text(),
		new Response(processHandle.stdout).text(),
	]);
	return { exitCode, stderr, stdout };
}

function permissions(path: string): number {
	return statSync(path).mode & 0o777;
}

interface ProcessResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}
