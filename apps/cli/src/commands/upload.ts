import { stat } from "node:fs/promises";
import { basename } from "node:path";
import * as p from "@clack/prompts";
import { buildCommand } from "@stricli/core";
import pMap from "p-map";
import {
	type RepoIdentity,
	resolveRepoIdentity,
	type Source,
} from "../contracts/index.js";
import {
	claudeCodeAdapter,
	type FileBackedUploadRequest,
	getAdapter,
	getAllAdapters,
	MissingTranscriptTimestampError,
	type ScannedProject,
	type SessionFile,
} from "../internal/agent-adapters/index.js";
import {
	type AutoUploadConfig,
	getRequiredAutoUploadSources,
	loadAutoUploadConfig,
	saveVisibleAutoUploadSelections,
} from "../lib/auto-upload-config.js";
import type { BatchUploadItem } from "../lib/batch-upload.js";
import { renderBatchSummary, runBatchUpload } from "../lib/batch-upload-ui.js";
import { classifySessionFile } from "../lib/classifier.js";
import { type Credentials, loadCredentials } from "../lib/credentials.js";
import {
	isRetryCandidate,
	loadFailedUploads,
	removeFailedUpload,
} from "../lib/failed-uploads.js";
import { type GitInfo, getGitInfo } from "../lib/git-info.js";
import { getProjectOrgId, setProjectOrgId } from "../lib/project-config.js";
import { scanAndGroupProjects } from "../lib/project-grouping.js";
import { resolveSession } from "../lib/session-resolver.js";
import {
	DEFAULT_ENDPOINT,
	SESSION_TAGS,
	type SessionTag,
} from "../lib/types.js";
import { allowsInsecureEndpoint } from "../lib/upload-endpoint.js";
import { getDefaultUploadOrganizationId } from "../lib/upload-organization.js";
import {
	groupUploadProjectsByRepository,
	orderUploadRepositoriesNewFirst,
	type ReconciledUploadProject,
	reconcileUploadProjects,
	type UploadProjectTarget,
	type UploadRepositoryGroup,
} from "../lib/upload-reconciliation.js";
import {
	formatRedactionSummary,
	type UploadConfig,
	uploadSession,
} from "../lib/uploader.js";

interface UploadFlags {
	tag?: SessionTag;
	endpoint?: string;
	allowInsecureEndpoint: boolean;
	classify: boolean;
	dryRun: boolean;
	org?: string;
	retry: boolean;
	yes: boolean;
	concurrency: number;
	forceReplace: boolean;
}

interface ResolvedUploadFlags extends UploadFlags {
	endpoint: string;
}

interface InteractiveUploadProject extends UploadProjectTarget {
	readonly duplicateSessions: readonly SessionFile[];
	readonly gitInfo: GitInfo | undefined;
	readonly hookInstalled: boolean;
	readonly newSessions: readonly SessionFile[];
	readonly repositoryIdentity: RepoIdentity;
	readonly statusKnown: boolean;
	readonly uploadedSessions: readonly SessionFile[];
}

type InteractiveUploadRepository =
	UploadRepositoryGroup<InteractiveUploadProject>;

interface UploadProjectMetadata {
	readonly gitInfo: GitInfo | undefined;
	readonly hookInstalled: boolean;
	readonly repositoryIdentity: RepoIdentity;
}

interface PreparedUploadTarget {
	readonly metadata: UploadProjectMetadata;
	readonly target: UploadProjectTarget;
}

async function runInteractiveUpload(
	flags: ResolvedUploadFlags,
	allowPlaintextEndpoint: boolean,
	credentials: Credentials | null,
): Promise<undefined | Error> {
	p.intro("opaline upload");

	const spin = p.spinner();
	spin.start("Scanning projects...");

	const { projects: allProjects, groups } = await scanAndGroupProjects({
		persistRemoteCache: !flags.dryRun,
	});

	if (allProjects.length === 0) {
		spin.stop("No local sessions found");
		p.log.warn("No projects with sessions found.");
		p.outro("Nothing to upload.");
		return;
	}

	const preparedTargets = await pMap(
		allProjects,
		(project) => prepareUploadTarget(project, flags.org),
		{ concurrency: 10 },
	);
	const organizations = credentials?.organizations ?? [];
	let defaultOrganizationId = getDefaultUploadOrganizationId(
		organizations,
		credentials?.user?.id,
	);
	if (
		preparedTargets.some(
			(prepared) => prepared.target.organizationId === undefined,
		) &&
		defaultOrganizationId === undefined &&
		organizations.length > 1
	) {
		spin.stop("Projects found");
		const selected = await p.select({
			message:
				"Choose a workspace for repositories without a saved destination",
			options: organizations.map((organization) => ({
				value: organization.id,
				label: organization.name,
			})),
		});
		if (p.isCancel(selected)) {
			p.cancel("Upload cancelled.");
			return;
		}
		defaultOrganizationId = selected;
		spin.start("Checking uploaded sessions...");
	}
	const targets = preparedTargets.map(({ target }) => ({
		...target,
		organizationId: target.organizationId ?? defaultOrganizationId,
	}));
	const metadataByProject = new Map<ScannedProject, UploadProjectMetadata>();
	for (const prepared of preparedTargets) {
		metadataByProject.set(prepared.target.project, prepared.metadata);
	}
	let uploadProjects: InteractiveUploadProject[];
	if (credentials) {
		spin.message("Checking which sessions are already uploaded...");
		let reconciled: ReconciledUploadProject[];
		try {
			reconciled = await reconcileUploadProjects(targets, {
				allowInsecureEndpoint: allowPlaintextEndpoint,
				authType: credentials.authType,
				endpoint: flags.endpoint,
				token: credentials.token,
			});
		} catch (error) {
			spin.stop("Could not check uploaded sessions");
			return error instanceof Error ? error : new Error(String(error));
		}
		uploadProjects = reconciled.map((project) => ({
			...project,
			organizationId: project.resolvedOrganizationId,
			...getUploadProjectMetadata(metadataByProject, project.project),
			statusKnown: true,
		}));
	} else {
		uploadProjects = targets.map((target) => ({
			...target,
			...getUploadProjectMetadata(metadataByProject, target.project),
			duplicateSessions: [],
			newSessions: target.project.sessions,
			statusKnown: false,
			uploadedSessions: [],
		}));
	}

	const totalLocalSessions = allProjects.reduce(
		(sum, project) => sum + project.sessionCount,
		0,
	);
	const totalNewSessions = uploadProjects.reduce(
		(sum, project) => sum + project.newSessions.length,
		0,
	);
	const totalUploadedSessions = uploadProjects.reduce(
		(sum, project) => sum + project.uploadedSessions.length,
		0,
	);
	const totalDuplicateSessions = uploadProjects.reduce(
		(sum, project) => sum + project.duplicateSessions.length,
		0,
	);
	spin.stop(
		credentials
			? `${totalNewSessions} new · ${totalUploadedSessions} already uploaded${
					totalDuplicateSessions > 0
						? ` · ${totalDuplicateSessions} local duplicate`
						: ""
				}`
			: `Found ${totalLocalSessions} local session(s)`,
	);

	const options: Array<{
		value: string;
		label: string;
	}> = [];
	const preSelected: string[] = [];
	const projectOrder = new Map<
		ScannedProject,
		{ readonly containsCwd: boolean; readonly index: number }
	>();
	let projectIndex = 0;
	for (const group of groups) {
		for (const project of group.projects) {
			projectOrder.set(project, {
				containsCwd: group.containsCwd,
				index: projectIndex,
			});
			projectIndex++;
		}
	}
	const autoUploadConfig = loadAutoUploadConfig();
	const repositories = groupUploadProjectsByRepository(uploadProjects);
	const orderedRepositories = orderUploadRepositoriesNewFirst(
		repositories,
		projectOrder,
	);

	for (const repository of orderedRepositories) {
		const autoUploadSelected = isRepositoryAutoUploadSelected(
			repository,
			autoUploadConfig,
		);
		options.push({
			value: repository.key,
			label: `${repository.label} (${getRepositoryUploadHint(repository)} · ${getRepositoryAutoUploadHint(repository, autoUploadSelected, autoUploadConfig)})`,
		});
		if (autoUploadSelected) preSelected.push(repository.key);
	}

	const selected = await p.multiselect({
		message: "Choose repositories for automatic upload",
		options,
		initialValues: preSelected,
		required: false,
	});

	if (p.isCancel(selected)) {
		p.cancel("Upload cancelled.");
		return;
	}
	const selectedRepoKeys = new Set(selected);
	const selectedRepositories = orderedRepositories.filter((repository) =>
		selectedRepoKeys.has(repository.key),
	);

	const totalSessions = selectedRepositories.reduce(
		(sum, repository) =>
			sum +
			getRepositorySessionsToUpload(repository, flags.forceReplace).length,
		0,
	);
	const skippedUploadedSessions = flags.forceReplace
		? 0
		: selectedRepositories.reduce(
				(sum, repository) =>
					sum + getRepositoryUploadedSessionCount(repository),
				0,
			);
	const skippedDuplicateSessions = selectedRepositories.reduce(
		(sum, repository) => sum + getRepositoryDuplicateSessionCount(repository),
		0,
	);

	if (flags.dryRun) {
		logAutoUploadSelectionPreview(
			orderedRepositories,
			selectedRepoKeys,
			autoUploadConfig,
		);
		for (const repository of selectedRepositories) {
			const count = getRepositorySessionsToUpload(
				repository,
				flags.forceReplace,
			).length;
			if (count === 0) continue;
			p.log.info(
				`Would upload ${sessionCountHint(count)} from ${repository.label}`,
			);
		}
		logSkippedSessions(skippedUploadedSessions, skippedDuplicateSessions);
		p.outro("Dry run complete — no settings changed and no sessions uploaded.");
		return;
	}

	if (!credentials) {
		return new Error("Not authenticated. Run `opaline login` first.");
	}
	for (const repository of selectedRepositories) {
		for (const project of repository.projects) {
			if (project.organizationId) {
				await setProjectOrgId(
					project.project.projectPath,
					project.organizationId,
				);
			}
		}
	}
	const savedAutoUploadConfig = saveVisibleAutoUploadSelections(
		orderedRepositories.map(toAutoUploadRepositorySelection),
		selectedRepoKeys,
	);
	const hookFailures = reconcileAutoUploadHooks(savedAutoUploadConfig);

	const uploadingRepositoryCount = selectedRepositories.filter(
		(repository) =>
			getRepositorySessionsToUpload(repository, flags.forceReplace).length > 0,
	).length;
	if (totalSessions > 0) {
		p.log.info(
			`Uploading ${totalSessions} session(s) from ${uploadingRepositoryCount} ${repositoryCountHint(uploadingRepositoryCount)}`,
		);
	} else if (selectedRepositories.length === 0) {
		p.log.info("Automatic upload is off for all visible repositories.");
	} else {
		p.log.info("No new sessions in the selected repositories.");
	}
	logSkippedSessions(skippedUploadedSessions, skippedDuplicateSessions);
	if (totalSessions === 0) {
		p.outro("Automatic upload settings saved.");
		if (hookFailures > 0) {
			return new Error(`${hookFailures} auto-upload hook change(s) failed.`);
		}
		return;
	}

	const uploadConfig: UploadConfig = {
		endpoint: flags.endpoint,
		token: credentials.token,
		allowInsecureEndpoint: allowPlaintextEndpoint,
		authType: credentials.authType,
	};

	// Flatten all sessions with their project context for concurrent upload
	const work: Array<{
		session: SessionFile;
		project: ScannedProject;
		adapter: ReturnType<typeof getAdapter>;
		gitInfo: Awaited<ReturnType<typeof getGitInfo>>;
		organizationId: string | undefined;
		repositoryLabel: string;
	}> = [];

	for (const repository of selectedRepositories) {
		for (const uploadProject of repository.projects) {
			const project = uploadProject.project;
			const adapter = getAdapter(project.source);
			const gitInfo =
				uploadProject.gitInfo ?? (await getGitInfo(project.projectPath));
			const organizationId = uploadProject.organizationId;
			for (const session of getSessionsToUpload(
				uploadProject,
				flags.forceReplace,
			)) {
				work.push({
					adapter,
					gitInfo,
					organizationId,
					project,
					repositoryLabel: repository.label,
					session,
				});
			}
		}
	}

	type InteractiveItem = BatchUploadItem & {
		session: (typeof work)[number]["session"];
		adapter: (typeof work)[number]["adapter"];
		gitInfo: (typeof work)[number]["gitInfo"];
	};

	const items: InteractiveItem[] = work.map((w) => ({
		sessionId: w.session.sessionId,
		label: `${w.repositoryLabel}/${w.session.sessionId}`,
		transcriptPath: w.session.transcriptPath,
		projectPath: w.session.projectPath,
		source: w.project.source,
		organizationId: w.organizationId,
		session: w.session,
		adapter: w.adapter,
		gitInfo: w.gitInfo,
	}));

	const summary = await runBatchUpload({
		items,
		label: "Uploading sessions...",
		concurrency: flags.concurrency,
		upload: async (item, onRetry) => {
			const request = await item.adapter.buildUploadRequest(item.session, {
				tag: flags.tag,
				gitInfo: item.gitInfo,
				organizationId: item.organizationId,
				uploadMode: "manual",
			});
			if (flags.forceReplace) request.metadata.force_replace = true;

			if (!flags.tag && flags.classify) {
				const classified = await classifySessionFile(request.transcriptPath);
				if (classified) {
					request.metadata.tag = classified;
				}
			}

			return uploadSession(request, { ...uploadConfig, onRetry });
		},
	});

	renderBatchSummary(summary, { showRetryHint: summary.failed > 0 });

	p.outro("Done!");

	if (summary.failed > 0) {
		return new Error(`${summary.failed} upload(s) failed.`);
	}
	if (hookFailures > 0) {
		return new Error(`${hookFailures} auto-upload hook change(s) failed.`);
	}
}

async function prepareUploadTarget(
	project: ScannedProject,
	overrideOrganizationId: string | undefined,
): Promise<PreparedUploadTarget> {
	const pathIdentity = resolveRepoIdentity({
		gitRemote: null,
		packageName: null,
		projectPath: project.projectPath,
	});
	const gitInfoPromise =
		pathIdentity.worktree === null
			? getGitInfo(project.projectPath)
			: Promise.resolve(undefined);
	const organizationIdPromise =
		overrideOrganizationId === undefined
			? getProjectOrgId(project.projectPath)
			: Promise.resolve(overrideOrganizationId);
	const [gitInfo, organizationId] = await Promise.all([
		gitInfoPromise,
		organizationIdPromise,
	]);
	const repositoryIdentity = gitInfo
		? resolveRepoIdentity({
				gitRemote: gitInfo.gitRemote ?? null,
				packageName: gitInfo.packageName ?? null,
				projectPath: project.projectPath,
			})
		: pathIdentity;

	return {
		metadata: {
			gitInfo,
			hookInstalled: getAdapter(project.source).isHookInstalled(),
			repositoryIdentity,
		},
		target: { organizationId, project },
	};
}

function getUploadProjectMetadata(
	metadataByProject: ReadonlyMap<ScannedProject, UploadProjectMetadata>,
	project: ScannedProject,
): UploadProjectMetadata {
	const metadata = metadataByProject.get(project);
	if (!metadata) throw new Error("Upload project metadata is missing");
	return metadata;
}

function isRepositoryAutoUploadSelected(
	repository: InteractiveUploadRepository,
	config: AutoUploadConfig | null,
): boolean {
	if (config) return config.repositories[repository.key] !== undefined;
	return repository.projects.some((project) => project.hookInstalled);
}

function getRepositoryAutoUploadHint(
	repository: InteractiveUploadRepository,
	autoUploadSelected: boolean,
	config: AutoUploadConfig | null,
): string {
	if (!autoUploadSelected) return "auto-upload off";
	const installedBySource = new Map<Source, boolean>();
	for (const project of repository.projects) {
		const source = project.project.source;
		const sourceSelected =
			config === null ||
			config.repositories[repository.key]?.sources.includes(source) === true;
		installedBySource.set(source, sourceSelected && project.hookInstalled);
	}
	const states = Array.from(installedBySource.values());
	if (states.every(Boolean)) return "auto-upload on";
	if (states.every((installed) => !installed) && states.length === 1) {
		return "auto-upload selected · hook missing";
	}
	return Array.from(
		installedBySource,
		([source, installed]) =>
			`${getAdapterName(source)} ${installed ? "on" : "off"}`,
	).join(" · ");
}

function getRepositoryUploadHint(
	repository: InteractiveUploadRepository,
): string {
	const newSessions = repository.projects.reduce(
		(sum, project) => sum + project.newSessions.length,
		0,
	);
	const uploadedSessions = getRepositoryUploadedSessionCount(repository);
	const duplicateSessions = getRepositoryDuplicateSessionCount(repository);
	const statusKnown = repository.projects.every(
		(project) => project.statusKnown,
	);
	if (!statusKnown) return sessionCountHint(newSessions);
	const details = [`${newSessions} new`, `${uploadedSessions} uploaded`];
	if (duplicateSessions > 0) {
		details.push(`${duplicateSessions} local duplicate`);
	}
	return details.join(" · ");
}

function getRepositorySessionsToUpload(
	repository: InteractiveUploadRepository,
	forceReplace: boolean,
): readonly SessionFile[] {
	return repository.projects.flatMap((project) =>
		getSessionsToUpload(project, forceReplace),
	);
}

function getRepositoryUploadedSessionCount(
	repository: InteractiveUploadRepository,
): number {
	return repository.projects.reduce(
		(sum, project) => sum + project.uploadedSessions.length,
		0,
	);
}

function getRepositoryDuplicateSessionCount(
	repository: InteractiveUploadRepository,
): number {
	return repository.projects.reduce(
		(sum, project) => sum + project.duplicateSessions.length,
		0,
	);
}

function toAutoUploadRepositorySelection(
	repository: InteractiveUploadRepository,
): {
	readonly key: string;
	readonly label: string;
	readonly sources: readonly Source[];
} {
	return {
		key: repository.key,
		label: repository.label,
		sources: Array.from(
			new Set(repository.projects.map((project) => project.project.source)),
		),
	};
}

function logAutoUploadSelectionPreview(
	repositories: readonly InteractiveUploadRepository[],
	selectedRepoKeys: ReadonlySet<string>,
	config: AutoUploadConfig | null,
): void {
	for (const repository of repositories) {
		const currentlySelected = isRepositoryAutoUploadSelected(
			repository,
			config,
		);
		const willBeSelected = selectedRepoKeys.has(repository.key);
		if (currentlySelected === willBeSelected) continue;
		p.log.info(
			`Would ${willBeSelected ? "enable" : "disable"} automatic upload for ${repository.label}`,
		);
	}
}

function reconcileAutoUploadHooks(config: AutoUploadConfig): number {
	const requiredSources = getRequiredAutoUploadSources(config);
	let failures = 0;
	for (const adapter of getAllAdapters()) {
		const required = requiredSources.has(adapter.source);
		const installed = adapter.isHookInstalled();
		if (required === installed) continue;
		try {
			if (required) {
				adapter.installHook();
				p.log.success(`${adapter.name}: automatic upload hook enabled`);
			} else {
				adapter.removeHook();
				p.log.success(`${adapter.name}: automatic upload hook removed`);
			}
		} catch (error) {
			failures++;
			p.log.error(
				`${adapter.name}: could not ${required ? "enable" : "remove"} automatic upload hook (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}
	return failures;
}

function getAdapterName(source: Source): string {
	return getAdapter(source).name;
}

function sessionCountHint(count: number): string {
	return `${count} session${count !== 1 ? "s" : ""}`;
}

function repositoryCountHint(count: number): string {
	return count === 1 ? "repository" : "repositories";
}

function getSessionsToUpload(
	project: InteractiveUploadProject,
	forceReplace: boolean,
): readonly SessionFile[] {
	return forceReplace
		? [...project.newSessions, ...project.uploadedSessions]
		: project.newSessions;
}

function logSkippedSessions(uploaded: number, duplicates: number): void {
	if (uploaded > 0) {
		p.log.info(
			`Skipping ${sessionCountHint(uploaded)} already uploaded to Opaline.`,
		);
	}
	if (duplicates > 0) {
		p.log.info(
			`Skipping ${sessionCountHint(duplicates)} duplicated in local discovery.`,
		);
	}
}

async function runSingleUpload(
	flags: ResolvedUploadFlags,
	session: string,
	allowPlaintextEndpoint: boolean,
	credentials: Credentials | null,
): Promise<undefined | Error> {
	const write = (msg: string) => {
		process.stdout.write(`${msg}\n`);
	};

	write(`Resolving session: ${session}`);
	let sessionInfo: Awaited<ReturnType<typeof resolveSession>>;
	try {
		sessionInfo = await resolveSession(session);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	write(`Found session at: ${sessionInfo.transcriptPath}`);

	const gitInfo = await getGitInfo(sessionInfo.projectPath);
	const displayName =
		gitInfo.gitRemote ||
		gitInfo.packageName ||
		basename(sessionInfo.projectPath);
	if (displayName) write(`Repository: ${displayName}`);
	if (gitInfo.branch) write(`Branch: ${gitInfo.branch}`);

	const organizationId =
		flags.org ?? (await getProjectOrgId(sessionInfo.projectPath));
	if (organizationId) write(`Organization: ${organizationId}`);

	write("Building upload request...");
	const sessionFile: SessionFile = {
		sessionId: sessionInfo.sessionId,
		transcriptPath: sessionInfo.transcriptPath,
		projectPath: sessionInfo.projectPath,
		gitBranch: sessionInfo.gitBranch,
		gitSha: sessionInfo.gitSha,
	};

	let request: FileBackedUploadRequest;
	try {
		request = await getAdapter(sessionInfo.source).buildUploadRequest(
			sessionFile,
			{
				tag: flags.tag,
				gitInfo,
				organizationId,
				uploadMode: "manual",
			},
		);
	} catch (error) {
		if (error instanceof MissingTranscriptTimestampError) {
			return new Error(
				"This transcript has no timestamped user/assistant messages, so it cannot be uploaded.",
			);
		}
		throw error;
	}

	const transcriptBytes = (await stat(request.transcriptPath)).size;
	write(`Transcript: ${transcriptBytes} bytes`);
	if (request.subagents.length > 0) {
		write(`Subagents: ${request.subagents.length} file(s)`);
	}

	if (flags.forceReplace) request.metadata.force_replace = true;

	if (flags.dryRun) {
		const subagents = await Promise.all(
			request.subagents.map(async (subagent) => ({
				agentId: subagent.agentId,
				content: `[${(await stat(subagent.path)).size} bytes]`,
			})),
		);
		const preview = {
			...request.metadata,
			content: `[${transcriptBytes} bytes]`,
			subagents: subagents.length > 0 ? subagents : undefined,
		};
		write("Dry run - would upload:");
		write(JSON.stringify(preview, null, 2));
		return;
	}

	if (!credentials) {
		return new Error("Not authenticated. Run `opaline login` first.");
	}

	if (!flags.tag && flags.classify) {
		write("Classifying session...");
		const classified = await classifySessionFile(request.transcriptPath);
		if (classified) {
			request.metadata.tag = classified;
			write(`Classified as: ${classified}`);
		}
	}

	write("Uploading...");
	const result = await uploadSession(request, {
		endpoint: flags.endpoint,
		token: credentials.token,
		allowInsecureEndpoint: allowPlaintextEndpoint,
		authType: credentials.authType,
	});

	if (result.success) {
		write("Upload successful!");
		await removeFailedUpload(request.metadata.sessionId);
		const redactionSummary = formatRedactionSummary(
			result.redacted,
			result.redactedBytes,
		);
		if (redactionSummary) {
			write(redactionSummary);
		}
	} else {
		return new Error(`Upload failed: ${result.error}`);
	}
}

async function runRetryUpload(
	flags: ResolvedUploadFlags,
	allowPlaintextEndpoint: boolean,
	credentials: Credentials | null,
): Promise<undefined | Error> {
	p.intro("opaline upload --retry");

	const failures = await loadFailedUploads();
	if (failures.length === 0) {
		p.outro("No failed uploads to retry.");
		return;
	}

	const retryableFailures = failures.filter((failure) =>
		isRetryCandidate(failure, flags.forceReplace),
	);
	const permanentFailures = failures.filter(
		(failure) => failure.status === "permanent",
	);
	p.log.info(
		`Found ${failures.length} failed upload(s): ${retryableFailures.length} retryable, ${permanentFailures.length} permanent`,
	);
	for (const f of failures.slice(0, 10)) {
		p.log.warn(`  [${f.status}] ${f.sessionId}: ${f.error} (${f.failedAt})`);
	}
	if (failures.length > 10) {
		p.log.warn(`  ...and ${failures.length - 10} more`);
	}
	if (permanentFailures.length > 0) {
		p.log.warn(
			flags.forceReplace
				? "Permanent shrink rejections are promoted by --force-replace; other permanent failures remain recorded."
				: "Permanent failures are retained for visibility and are not retried automatically.",
		);
	}
	if (retryableFailures.length === 0) {
		p.outro("No retryable uploads. Permanent failures remain recorded.");
		return;
	}

	if (flags.dryRun) {
		p.outro(
			`Dry run complete — ${retryableFailures.length} retryable upload(s) were not sent.`,
		);
		return;
	}

	if (!credentials) {
		return new Error("Not authenticated. Run `opaline login` first.");
	}

	if (!flags.yes) {
		const shouldRetry = await p.confirm({
			message: `Retry ${retryableFailures.length} retryable upload(s)?`,
			initialValue: true,
		});

		if (p.isCancel(shouldRetry) || !shouldRetry) {
			p.cancel("Retry cancelled.");
			return;
		}
	}

	type RetryItem = BatchUploadItem & {
		failure: (typeof failures)[number];
	};

	const items: RetryItem[] = retryableFailures.map((f) => ({
		sessionId: f.sessionId,
		label: f.sessionId,
		transcriptPath: f.transcriptPath,
		projectPath: f.projectPath,
		source: f.source,
		organizationId: f.organizationId,
		failure: f,
	}));

	const { token, authType } = credentials;
	const summary = await runBatchUpload({
		items,
		label: "Retrying uploads...",
		concurrency: flags.concurrency,
		upload: async (item, onRetry) => {
			const adapter = item.failure.source
				? getAdapter(item.failure.source)
				: claudeCodeAdapter;
			const sessionFile: SessionFile = {
				sessionId: item.failure.sessionId,
				transcriptPath: item.failure.transcriptPath,
				projectPath: item.failure.projectPath,
			};
			const gitInfo = await getGitInfo(item.failure.projectPath);
			const organizationId =
				flags.org ??
				item.failure.organizationId ??
				(await getProjectOrgId(item.failure.projectPath));

			const request = await adapter.buildUploadRequest(sessionFile, {
				tag: flags.tag,
				gitInfo,
				organizationId,
				uploadMode: "retry",
			});
			if (flags.forceReplace) request.metadata.force_replace = true;

			return uploadSession(request, {
				endpoint: flags.endpoint,
				token,
				allowInsecureEndpoint: allowPlaintextEndpoint,
				authType,
				onRetry,
			});
		},
	});

	renderBatchSummary(summary);

	p.outro("Done!");

	if (summary.failed > 0) {
		return new Error(`${summary.failed} upload(s) failed.`);
	}
}

async function runUpload(
	flags: UploadFlags,
	...sessions: string[]
): Promise<undefined | Error> {
	const credentials = loadCredentials();
	if (!credentials && !flags.dryRun) {
		return new Error("Not authenticated. Run `opaline login` first.");
	}
	const apiBaseUrl = credentials?.apiBaseUrl.replace(/\/+$/u, "");
	const resolvedFlags: ResolvedUploadFlags = {
		...flags,
		endpoint:
			flags.endpoint ??
			(apiBaseUrl === undefined ? DEFAULT_ENDPOINT : `${apiBaseUrl}/rpc`),
	};
	const allowPlaintextEndpoint = allowsInsecureEndpoint(
		resolvedFlags.allowInsecureEndpoint,
	);
	if (resolvedFlags.retry) {
		return runRetryUpload(resolvedFlags, allowPlaintextEndpoint, credentials);
	}
	if (sessions.length === 0) {
		return runInteractiveUpload(
			resolvedFlags,
			allowPlaintextEndpoint,
			credentials,
		);
	}
	return runSingleUpload(
		resolvedFlags,
		sessions[0] as string,
		allowPlaintextEndpoint,
		credentials,
	);
}

export const uploadCommand = buildCommand({
	loader: async () => ({ default: runUpload }),
	parameters: {
		positional: {
			kind: "array",
			parameter: {
				brief: "Session ID or path to a session .jsonl file",
				parse: String,
				placeholder: "session",
			},
		},
		flags: {
			tag: {
				kind: "enum",
				values: [...SESSION_TAGS],
				brief: "Session tag/category",
				optional: true,
			},
			endpoint: {
				kind: "parsed",
				parse: String,
				brief: "Override the upload endpoint URL",
				optional: true,
			},
			allowInsecureEndpoint: {
				kind: "boolean",
				brief: "Allow plaintext uploads to a non-loopback endpoint",
				default: false,
			},
			classify: {
				kind: "boolean",
				brief: "Auto-classify session tag using Claude CLI",
				default: false,
			},
			dryRun: {
				kind: "boolean",
				brief: "Preview what would be uploaded without sending",
				default: false,
			},
			org: {
				kind: "parsed",
				parse: String,
				brief: "Override the organization ID to upload to",
				optional: true,
			},
			retry: {
				kind: "boolean",
				brief: "Retry previously failed uploads",
				default: false,
			},
			yes: {
				kind: "boolean",
				brief: "Skip the confirmation prompt for --retry",
				default: false,
			},
			concurrency: {
				kind: "parsed",
				parse: Number,
				brief: "Max concurrent uploads",
				default: "5",
			},
			forceReplace: {
				kind: "boolean",
				brief: "Intentionally replace a stored session with smaller content",
				default: false,
			},
		},
		aliases: {
			t: "tag",
			c: "classify",
			n: "dryRun",
			o: "org",
			r: "retry",
			y: "yes",
			j: "concurrency",
		},
	},
	docs: {
		brief:
			"Sync sessions and manage automatic upload by repository. Pass a session for a one-off upload.",
	},
});
