import { afterEach, describe, expect, test } from "bun:test";
import type { SafeUrlResult } from "../contracts/index.js";
import {
	allowsInsecureApiBaseFromEnv,
	allowsPlaintext,
	describeApiBaseRejection,
	describeLogoutApiBaseRisk,
	describeStoredApiBaseRisk,
	resolveApiBase,
} from "../lib/api-base.js";

const ENV_VAR = "RUDEL_ALLOW_INSECURE_API_BASE";
const originalEnvValue = process.env[ENV_VAR];

afterEach(() => {
	if (originalEnvValue === undefined) {
		delete process.env[ENV_VAR];
	} else {
		process.env[ENV_VAR] = originalEnvValue;
	}
});

function rejection(
	result: SafeUrlResult,
): Extract<SafeUrlResult, { ok: false }> {
	if (result.ok) {
		throw new Error(`expected rejection, got accepted URL: ${result.url}`);
	}
	return result;
}

function acceptedUrl(result: SafeUrlResult): string {
	if (!result.ok) {
		throw new Error(`expected acceptance, got rejection: ${result.detail}`);
	}
	return result.url;
}

describe("resolveApiBase", () => {
	test("refuses plaintext to a non-loopback host by default", () => {
		delete process.env[ENV_VAR];

		expect(
			rejection(resolveApiBase("http://evil.example", allowsPlaintext(false)))
				.reason,
		).toBe("plaintext_non_loopback");
	});

	test("allows plaintext when the flag is passed", () => {
		delete process.env[ENV_VAR];

		expect(
			acceptedUrl(
				resolveApiBase("http://internal.example", allowsPlaintext(true)),
			),
		).toBe("http://internal.example");
	});

	test("allows plaintext when the env var is set", () => {
		process.env[ENV_VAR] = "1";

		expect(
			acceptedUrl(
				resolveApiBase("http://internal.example", allowsPlaintext(false)),
			),
		).toBe("http://internal.example");
	});

	test.each(["http://localhost:4010", "https://opaline.so"])(
		"accepts %p with neither the flag nor the env var",
		(input) => {
			delete process.env[ENV_VAR];

			expect(acceptedUrl(resolveApiBase(input, allowsPlaintext(false)))).toBe(
				input,
			);
		},
	);

	test("normalizes away a trailing slash", () => {
		delete process.env[ENV_VAR];

		// Otherwise `${apiBase}/api/auth/device/code` gains a doubled slash.
		expect(
			acceptedUrl(
				resolveApiBase("https://opaline.so/", allowsPlaintext(false)),
			),
		).toBe("https://opaline.so");
	});

	test("still refuses a non-http scheme when the override is set", () => {
		process.env[ENV_VAR] = "1";

		expect(
			rejection(resolveApiBase("file:///etc/passwd", allowsPlaintext(true)))
				.reason,
		).toBe("disallowed_scheme");
	});
});

describe("allowsInsecureApiBaseFromEnv", () => {
	test.each(["1", "true", "TRUE", "yes", "on"])(
		"treats %p as opting in",
		(value) => {
			process.env[ENV_VAR] = value;

			expect(allowsInsecureApiBaseFromEnv()).toBe(true);
		},
	);

	test.each(["0", "false", "no", "", "maybe"])(
		"treats %p as not opting in",
		(value) => {
			process.env[ENV_VAR] = value;

			expect(allowsInsecureApiBaseFromEnv()).toBe(false);
		},
	);

	test("is false when unset", () => {
		delete process.env[ENV_VAR];

		expect(allowsInsecureApiBaseFromEnv()).toBe(false);
	});
});

describe("describeApiBaseRejection", () => {
	test("offers the override only when overriding would help", () => {
		delete process.env[ENV_VAR];
		const message = describeApiBaseRejection(
			rejection(resolveApiBase("http://evil.example", allowsPlaintext(false))),
		);

		expect(message).toContain("--allow-insecure-api-base");
		expect(message).toContain("--allow-insecure-endpoint");
	});

	test.each(["file:///etc/passwd", "not a url"])(
		"does not offer a useless override for %p",
		(input) => {
			process.env[ENV_VAR] = "1";
			const message = describeApiBaseRejection(
				rejection(resolveApiBase(input, allowsPlaintext(true))),
			);

			expect(message).not.toContain("--allow-insecure-api-base");
		},
	);
});

describe("describeLogoutApiBaseRisk", () => {
	test("warns without telling the user to log out again", () => {
		const warning = describeLogoutApiBaseRisk("http://internal.example");

		expect(warning).toContain("plaintext");
		expect(warning).not.toContain("rudel logout");
		expect(warning).not.toContain("rudel login");
	});

	test("never steers the user toward --local-only", () => {
		// Leaving a live key valid on the server is strictly worse than revoking it
		// over the same plaintext connection the key already traversed.
		expect(describeLogoutApiBaseRisk("http://internal.example")).not.toContain(
			"--local-only",
		);
	});

	test.each(["https://opaline.so", "http://localhost:4010"])(
		"stays silent for %p",
		(storedApiBase) => {
			expect(describeLogoutApiBaseRisk(storedApiBase)).toBeUndefined();
		},
	);
});

describe("describeStoredApiBaseRisk", () => {
	test("warns about an already-saved plaintext base", () => {
		const warning = describeStoredApiBaseRisk("http://internal.example");

		expect(warning).toContain("plaintext");
		expect(warning).toContain("opaline logout");
	});

	test("warns even when the insecure override is set", () => {
		// The warning describes what was persisted, not what is being chosen now.
		process.env[ENV_VAR] = "1";

		expect(describeStoredApiBaseRisk("http://internal.example")).toBeString();
	});

	test.each(["https://opaline.so", "http://localhost:4010"])(
		"stays silent for %p",
		(storedApiBase) => {
			expect(describeStoredApiBaseRisk(storedApiBase)).toBeUndefined();
		},
	);
});
