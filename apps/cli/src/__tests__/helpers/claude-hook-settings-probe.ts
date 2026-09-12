import {
	addHook,
	getClaudeSettingsPath,
	isHookEnabled,
	removeHook,
} from "../../internal/agent-adapters/adapters/claude-code/settings.js";

if (process.argv[2] === "install") addHook();
if (process.argv[2] === "remove") removeHook();
console.log(
	JSON.stringify({ path: getClaudeSettingsPath(), enabled: isHookEnabled() }),
);
