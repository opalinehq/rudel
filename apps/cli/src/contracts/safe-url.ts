/**
 * Validation for URLs that cross an untrusted boundary before being handed to
 * an OS browser opener or printed to a terminal.
 *
 * Applied before the CLI opens a server-provided device-verification URL or
 * sends credentials to a configured API endpoint.
 *
 * Threat model (RUD-203): the device-authorization verification URL is supplied
 * by whatever server `--api-base` points at. Handing that string to a platform
 * opener escalates "talked to a hostile server" into "code ran locally":
 *
 * - Windows: `spawn("cmd", ["/c", "start", "", url])` re-parses the URL as a
 *   command line. libuv only quotes arguments containing space, tab or `"`, so
 *   `&`, `|`, `^`, `(`, `)` reach cmd.exe verbatim as operators.
 * - macOS/Linux: `open`/`xdg-open` dispatch any registered URL scheme, accept
 *   plain filesystem paths (`/Applications/Calculator.app` launches an app) and
 *   parse a leading `-` as their own flags.
 *
 * IMPORTANT: parsing alone does NOT make a URL safe to hand to cmd.exe. `&`,
 * `|`, `(`, `)` and (in a query) `^` all survive WHATWG URL serialization, so
 * `https://opaline.so/device?user_code=X&calc` passes every check here while
 * still injecting on Windows. That is why the Windows opener must not use a
 * shell at all — this validator and the shell-free opener are complementary,
 * not alternatives, and they cover disjoint platforms.
 */

const LOOPBACK_HOSTNAMES = ["localhost", "[::1]"] as const;
const LOOPBACK_IPV4_REGEX = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const TRAILING_SLASH_REGEX = /\/+$/;
const REPLACEMENT_CHARACTER = "\u{FFFD}";
const MAX_DISPLAY_LENGTH = 200;

const C0_CONTROL_END = 0x1f;
const DELETE_CHARACTER = 0x7f;
const C1_CONTROL_END = 0x9f;

export type SafeUrlRejectionReason =
	| "malformed"
	| "disallowed_scheme"
	| "plaintext_non_loopback"
	| "embedded_credentials"
	| "unexpected_query_or_fragment"
	| "control_characters";

export type SafeUrlResult =
	| { ok: true; url: string }
	| { ok: false; reason: SafeUrlRejectionReason; detail: string };

/**
 * C0 controls, DEL, and C1 controls. Checked by code point rather than by a
 * regex so this file contains no literal control characters.
 */
function isControlCodePoint(codePoint: number): boolean {
	if (codePoint <= C0_CONTROL_END) {
		return true;
	}
	return codePoint >= DELETE_CHARACTER && codePoint <= C1_CONTROL_END;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (isControlCodePoint(value.charCodeAt(index))) {
			return true;
		}
	}
	return false;
}

/**
 * True for hosts that never leave the machine, where plaintext http: is
 * acceptable. `hostname` from the WHATWG parser is already lowercased and keeps
 * brackets on IPv6 literals.
 */
export function isLoopbackHostname(hostname: string): boolean {
	if (LOOPBACK_HOSTNAMES.some((candidate) => candidate === hostname)) {
		return true;
	}
	return LOOPBACK_IPV4_REGEX.test(hostname);
}

/**
 * Render an untrusted string for terminal or log output. Control characters are
 * replaced (not stripped) so an ANSI escape sequence cannot repaint the
 * terminal or hide text, and the result is truncated.
 */
export function sanitizeForTerminalDisplay(value: string): string {
	let escaped = "";
	for (const character of value) {
		escaped += isControlCodePoint(character.charCodeAt(0))
			? REPLACEMENT_CHARACTER
			: character;
	}
	if (escaped.length <= MAX_DISPLAY_LENGTH) {
		return escaped;
	}
	return `${escaped.slice(0, MAX_DISPLAY_LENGTH)}\u{2026}`;
}

function validateCommon(input: string): SafeUrlResult {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return {
			ok: false,
			reason: "malformed",
			detail: "not a valid absolute URL",
		};
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return {
			ok: false,
			reason: "disallowed_scheme",
			// `protocol` comes from the URL parser, so it cannot carry control
			// characters and is safe to interpolate into a message.
			detail: `scheme "${parsed.protocol}" is not allowed (expected https:)`,
		};
	}

	// `https://opaline.so@evil.example/device` resolves to evil.example while
	// reading as the real host. We print this URL for the user to copy, so
	// userinfo is a spoofing vector, not just a credential-leak one.
	if (parsed.username !== "" || parsed.password !== "") {
		return {
			ok: false,
			reason: "embedded_credentials",
			detail: "URL must not contain embedded credentials",
		};
	}

	const serialized = parsed.toString();
	if (hasControlCharacter(serialized)) {
		return {
			ok: false,
			reason: "control_characters",
			detail: "URL contains control characters",
		};
	}

	return { ok: true, url: serialized };
}

/** True when `parsed` is plaintext http: to a host that leaves the machine. */
function isPlaintextNonLoopback(parsed: URL): boolean {
	return parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname);
}

/**
 * Validate a URL that will be opened in the user's browser and printed to the
 * terminal. Requires https:, except on loopback hosts, or when `allowPlaintext`
 * records that the operator has explicitly accepted a plaintext deployment.
 *
 * `allowPlaintext` must be threaded from the same opt-in that governs the API
 * base: a self-hosted plaintext deployment serves its verification frontend over
 * http: too, so refusing it here while accepting the API base would make the
 * opt-in useless (it did, until this was fixed).
 *
 * Returns the reserialized URL — callers MUST use the returned value rather
 * than their original input, otherwise the percent-encoding of control
 * characters, `<`, `>` and spaces is discarded.
 */
export function parseSafeBrowserUrl(
	input: string,
	options: { allowPlaintext: boolean },
): SafeUrlResult {
	const result = validateCommon(input);
	if (!result.ok) {
		return result;
	}

	const parsed = new URL(result.url);
	if (isPlaintextNonLoopback(parsed) && !options.allowPlaintext) {
		return {
			ok: false,
			reason: "plaintext_non_loopback",
			detail: `plaintext http: is only allowed for loopback hosts (got "${parsed.hostname}")`,
		};
	}

	return result;
}

/**
 * Validate a full API endpoint that will receive credentials and request data.
 *
 * Unlike an API base, an endpoint may intentionally carry a path, query string,
 * fragment, or trailing slash. It therefore shares the common scheme,
 * credential, control-character, and plaintext checks without applying base
 * normalization.
 */
export function parseSafeApiEndpoint(
	input: string,
	options: { allowPlaintext: boolean },
): SafeUrlResult {
	const result = validateCommon(input);
	if (!result.ok) {
		return result;
	}

	const parsed = new URL(result.url);
	if (isPlaintextNonLoopback(parsed) && !options.allowPlaintext) {
		return {
			ok: false,
			reason: "plaintext_non_loopback",
			detail: `refusing to send credentials over plaintext http: to "${parsed.hostname}"`,
		};
	}

	return result;
}

/**
 * Validate an API base URL that will receive the device code, the access token
 * and the minted ingest API key (RUD-237).
 *
 * Set `allowPlaintext` to permit non-loopback http: — an explicit, opt-in
 * downgrade for plaintext internal deployments.
 *
 * Returns the base with trailing slashes removed, so callers can safely
 * template `${base}/api/...` without producing a doubled slash.
 */
export function parseSafeApiBase(
	input: string,
	options: { allowPlaintext: boolean },
): SafeUrlResult {
	const result = parseSafeApiEndpoint(input, options);
	if (!result.ok) {
		return result;
	}

	const parsed = new URL(result.url);
	// Callers template `${base}/api/...` onto this, which a query string or
	// fragment silently swallows: `https://host?a=1` would yield
	// `https://host/?a=1/api/auth/device/code`. Reject rather than guess.
	if (parsed.search !== "" || parsed.hash !== "") {
		return {
			ok: false,
			reason: "unexpected_query_or_fragment",
			detail: "API base must not contain a query string or fragment",
		};
	}

	return { ok: true, url: result.url.replace(TRAILING_SLASH_REGEX, "") };
}
