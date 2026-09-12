import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { normalizeLegacyProductionApiBase } from "./api-target.js";
import { debugLog } from "./debug.js";
import { getConfigDir } from "./local-state.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface Credentials {
	token: string;
	apiBaseUrl: string;
	authType?: "bearer" | "api-key";
	apiKeyId?: string;
	user?: {
		id: string;
		email: string;
		name: string;
	};
	organizations?: Array<{
		id: string;
		name: string;
		slug: string;
	}>;
}

export type CredentialReadMode = "secure" | "read-only";

export function saveCredentials(credentials: Credentials): void {
	const dir = getConfigDir();
	const path = getCredentialsPath(dir);
	const content = JSON.stringify(
		{
			...credentials,
			apiBaseUrl: normalizeLegacyProductionApiBase(credentials.apiBaseUrl),
		},
		null,
		2,
	);
	debugLog("saving credentials", { path });

	mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	enforcePrivateMode(dir, PRIVATE_DIRECTORY_MODE);
	if (existsSync(path)) {
		enforcePrivateMode(path, PRIVATE_FILE_MODE);
	}
	replaceCredentialsFile(path, content);
}

export function loadCredentials(
	mode: CredentialReadMode = "secure",
	dir: string = getConfigDir(),
): Credentials | null {
	const path = getCredentialsPath(dir);
	const exists = existsSync(path);
	debugLog("checking credentials", { exists, path });
	if (!exists) return null;

	if (mode === "secure") {
		enforcePrivateMode(dir, PRIVATE_DIRECTORY_MODE);
		enforcePrivateMode(path, PRIVATE_FILE_MODE);
	}
	const content = readFileSync(path, "utf-8");
	return parseCredentials(content);
}

export function clearCredentials(): void {
	const path = getCredentialsPath(getConfigDir());
	if (existsSync(path)) {
		rmSync(path);
	}
}

function getCredentialsPath(configDir: string): string {
	return join(configDir, "credentials.json");
}

function parseCredentials(content: string): Credentials {
	const value: unknown = JSON.parse(content);
	if (!isRecord(value)) {
		throw new Error("Credentials file must contain an object");
	}

	const token = value.token;
	const apiBaseUrl = value.apiBaseUrl;
	if (typeof token !== "string" || typeof apiBaseUrl !== "string") {
		throw new Error("Credentials file is missing token or apiBaseUrl");
	}

	const authType = parseAuthType(value.authType);
	const apiKeyId =
		typeof value.apiKeyId === "string" ? value.apiKeyId : undefined;
	const user = parseUser(value.user);
	const organizations = parseOrganizations(value.organizations);

	return {
		token,
		apiBaseUrl: normalizeLegacyProductionApiBase(apiBaseUrl),
		authType,
		apiKeyId,
		user,
		organizations,
	};
}

function parseAuthType(value: unknown): Credentials["authType"] {
	return value === "bearer" || value === "api-key" ? value : undefined;
}

function parseUser(value: unknown): Credentials["user"] {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.email !== "string" ||
		typeof value.name !== "string"
	) {
		return undefined;
	}
	return { id: value.id, email: value.email, name: value.name };
}

function parseOrganizations(value: unknown): Credentials["organizations"] {
	if (!Array.isArray(value)) return undefined;
	const organizations: NonNullable<Credentials["organizations"]> = [];
	for (const candidate of value) {
		if (!isRecord(candidate)) continue;
		if (
			typeof candidate.id !== "string" ||
			typeof candidate.name !== "string" ||
			typeof candidate.slug !== "string"
		) {
			continue;
		}
		organizations.push({
			id: candidate.id,
			name: candidate.name,
			slug: candidate.slug,
		});
	}
	return organizations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function replaceCredentialsFile(path: string, content: string): void {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

	try {
		writeFileSync(temporaryPath, content, {
			encoding: "utf8",
			flag: "wx",
			mode: PRIVATE_FILE_MODE,
		});
		enforcePrivateMode(temporaryPath, PRIVATE_FILE_MODE);
		renameSync(temporaryPath, path);
		enforcePrivateMode(path, PRIVATE_FILE_MODE);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function enforcePrivateMode(path: string, mode: number): void {
	// Windows does not expose POSIX owner/group/other modes through chmod.
	// Its per-user directory ACL is the credential-store security boundary.
	if (process.platform === "win32") return;

	chmodSync(path, mode);
	if ((statSync(path).mode & 0o777) !== mode) {
		throw new Error("Unable to establish private credential permissions");
	}
}
