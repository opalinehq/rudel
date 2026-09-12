export const PRODUCTION_API_BASE = "https://opaline.so";
const LEGACY_PRODUCTION_API_BASE = "https://app.rudel.ai";

export function normalizeLegacyProductionApiBase(apiBaseUrl: string): string {
	return apiBaseUrl === LEGACY_PRODUCTION_API_BASE ||
		apiBaseUrl === `${LEGACY_PRODUCTION_API_BASE}/`
		? PRODUCTION_API_BASE
		: apiBaseUrl;
}

export function getApiBaseOverride(
	environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return environment.OPALINE_API_BASE ?? environment.RUDEL_API_BASE;
}

export function getDefaultApiBase(
	environment: NodeJS.ProcessEnv = process.env,
): string {
	return getApiBaseOverride(environment) ?? PRODUCTION_API_BASE;
}
