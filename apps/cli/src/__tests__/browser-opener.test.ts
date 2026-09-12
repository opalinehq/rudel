import { describe, expect, test } from "bun:test";
import { buildVerificationUrl } from "../commands/login.js";
import { resolveBrowserOpener } from "../lib/browser-opener.js";

describe("resolveBrowserOpener", () => {
	test("keeps every URL byte off the parsed command line on Windows", () => {
		// The RUD-203 vulnerability was `spawn("cmd", ["/c", "start", "", url])`.
		// cmd.exe re-parses its command line, so `&` in a server-supplied URL became
		// a command separator. The invariant is that no fragment of the URL appears
		// in the command or its arguments — it may only travel via the environment,
		// which nothing parses.
		const url = "https://opaline.so/device?user_code=X&calc";
		const { command, args } = resolveBrowserOpener("win32", url);

		expect(command).not.toBe("cmd");
		expect(command).not.toBe("cmd.exe");
		expect(command).not.toContain("rundll32");
		for (const arg of args) {
			expect(arg).not.toContain("opaline.so");
			expect(arg).not.toContain("user_code");
			expect(arg).not.toContain("&");
		}
	});

	test("ShellExecutes via a constant Start-Process command on Windows", () => {
		// explorer.exe silently ignores http URLs with a query string, so the
		// opener ShellExecutes through Start-Process with the URL in an env var.
		// Plain -Command text, never the EDR-flagged -EncodedCommand pattern.
		const url = "https://opaline.so/device?user_code=X&calc";
		const { command, args, detach, env } = resolveBrowserOpener("win32", url);

		expect(command).toBe("powershell.exe");
		expect(args.at(-1)).toBe("Start-Process -FilePath $env:OPALINE_OPEN_URL");
		expect(args).not.toContain("-EncodedCommand");
		expect(env).toEqual({ OPALINE_OPEN_URL: url });
		// DETACHED_PROCESS makes Start-Process report success while the browser
		// launch silently dies (bisected on windows-2025 CI).
		expect(detach).toBe(false);
	});

	test.each([
		["darwin", "open"],
		["linux", "xdg-open"],
		["freebsd", "xdg-open"],
	])("uses %p opener %p", (platform, expected) => {
		const url = "https://opaline.so/device?user_code=X";
		const { command, args, detach, env } = resolveBrowserOpener(platform, url);

		expect(command).toBe(expected);
		expect(args).toEqual([url]);
		expect(detach).toBe(true);
		expect(env).toBeUndefined();
	});
});

describe("buildVerificationUrl", () => {
	test("prefers the server-supplied complete URL", () => {
		expect(
			buildVerificationUrl({
				verification_uri: "https://opaline.so/device",
				verification_uri_complete:
					"https://opaline.so/device?user_code=ABCD1234",
				user_code: "ABCD1234",
			}),
		).toBe("https://opaline.so/device?user_code=ABCD1234");
	});

	test("appends the user code when no complete URL is supplied", () => {
		expect(
			buildVerificationUrl({
				verification_uri: "https://opaline.so/device",
				verification_uri_complete: undefined,
				user_code: "ABCD1234",
			}),
		).toBe("https://opaline.so/device?user_code=ABCD1234");
	});

	test("does not corrupt a verification URI that already has a query string", () => {
		// Regression test: `?`-concatenation produced two `?` separators and a
		// malformed URL. Reachable via CLI_DEVICE_VERIFICATION_URL.
		const built = buildVerificationUrl({
			verification_uri: "https://opaline.so/device?tenant=acme",
			verification_uri_complete: undefined,
			user_code: "ABCD1234",
		});

		expect(built.match(/\?/g)).toHaveLength(1);
		expect(new URL(built).searchParams.get("tenant")).toBe("acme");
		expect(new URL(built).searchParams.get("user_code")).toBe("ABCD1234");
	});

	test("percent-encodes a user code containing URL-significant characters", () => {
		const built = buildVerificationUrl({
			verification_uri: "https://opaline.so/device",
			verification_uri_complete: undefined,
			user_code: "AB&CD=EF",
		});

		expect(new URL(built).searchParams.get("user_code")).toBe("AB&CD=EF");
		expect(built).toContain("AB%26CD%3DEF");
	});

	test("returns a malformed verification URI unchanged for the validator to reject", () => {
		expect(
			buildVerificationUrl({
				verification_uri: "not a url",
				verification_uri_complete: undefined,
				user_code: "ABCD1234",
			}),
		).toBe("not a url");
	});
});
