/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitPullRequestSearchCriteria, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { AzdoRepository } from './azdoRepository';
import { AZDO_CONFIG_NAMESPACE, getAzdoConfigOrgUrl, getAzdoConfigProjectName } from './config';
import { AzdoCredentialStore } from './credentials';
import { AzdoPullRequestGitHelper, AzdoRemoteEntry } from './pullRequestGitHelper';
import { AzdoPullRequestModel } from './pullRequestModel';
import { applyAzdoConfigOverrides, AzdoRemoteInfo, parseAzdoRemoteUrl } from './remote';
import { convertIdentityRefToAccount } from './utils';
import { Branch, Repository } from '../api/api';
import { GitApiImpl } from '../api/api1';
import { GitHubServerType } from '../common/authentication';
import Logger from '../common/logger';
import { GitHubRemote, parseRepositoryRemotesAsync, Remote } from '../common/remote';
import { PR_SETTINGS_NAMESPACE, REMOTES } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { CredentialStore } from '../github/credentials';
import { FolderRepositoryManager, ReposManagerState } from '../github/folderRepositoryManager';
import { GitHubRepository, PullRequestData } from '../github/githubRepository';
import { IAccount } from '../github/interface';
import { PullRequestGitHelper, PullRequestMetadata } from '../github/pullRequestGitHelper';
import { PullRequestModel } from '../github/pullRequestModel';
import { IThemeWatcher } from '../themeWatcher';
import { CreatePullRequestHelper } from '../view/createPullRequestHelper';
/**
 * A `FolderRepositoryManager` whose workspace repository talks to Azure DevOps.
 *
 * `updateRepositories` is fully overridden: remotes are parsed with `parseAzdoRemoteUrl` and
 * wrapped in `AzdoRepository`s. Repositories without any AzDO remote fall back to the base
 * GitHub behavior, keeping the GitHub surfaces functional and dormant per ADR 0002.
 */
export class AzdoFolderRepositoryManager extends FolderRepositoryManager {
	public readonly azdoCredentialStore: AzdoCredentialStore;

	private _azdoRepositoryCounter = 0;
	private _azdoUpdatingRepositories: Promise<boolean> | undefined;
	private _azdoPromptedForAuth = false;
	private _azdoRemoteInfos: AzdoRemoteInfo[] = [];
	constructor(
		id: number,
		context: vscode.ExtensionContext,
		repository: Repository,
		telemetry: ITelemetry,
		git: GitApiImpl,
		credentialStore: CredentialStore,
		createPullRequestHelper: CreatePullRequestHelper,
		themeWatcher: IThemeWatcher,
		azdoCredentialStore: AzdoCredentialStore,
	) {
		super(id, context, repository, telemetry, git, credentialStore, createPullRequestHelper, themeWatcher);
		this.azdoCredentialStore = azdoCredentialStore;
		this._register(azdoCredentialStore.onDidChangeCredentials(() => {
			// Credentials changed (e.g. signed in through the Accounts menu): rescan.
			this._azdoPromptedForAuth = false;
			this.updateRepositories(true).catch(error => Logger.error(`AzDO repository refresh failed: ${error}`, 'AzdoFolderRepositoryManager'));
		}));
		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			// Explicit `azdo.*` settings changed: rescan with the new overrides.
			if (e.affectsConfiguration(AZDO_CONFIG_NAMESPACE)) {
				this._azdoPromptedForAuth = false;
				this.updateRepositories(true).catch(error => Logger.error(`AzDO repository refresh failed: ${error}`, 'AzdoFolderRepositoryManager'));
			}
		}));
	}

	/**
	 * Scans the git remotes and returns the AzDO remotes, deduplicated per
	 * org/project/repository and filtered by the `remotes` setting, mirroring the base class.
	 */
	private async getAzdoRemotes(): Promise<{ remote: Remote; info: AzdoRemoteInfo }[]> {
		const remotes = await parseRepositoryRemotesAsync(this.repository);
		const remotesSetting = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string[]>(REMOTES);
		const config = { orgUrl: getAzdoConfigOrgUrl(), project: getAzdoConfigProjectName() };
		const result: { remote: Remote; info: AzdoRemoteInfo }[] = [];
		const seen = new Set<string>();
		for (const remote of remotes) {
			if (remotesSetting?.length && !remotesSetting.includes(remote.remoteName)) {
				continue;
			}
			const info = applyAzdoConfigOverrides(parseAzdoRemoteUrl(remote.url, remote.remoteName), remote.url, remote.remoteName, config);
			if (!info) {
				continue;
			}
			const key = `${info.orgUrl.toLowerCase()}|${info.project.toLowerCase()}|${info.repositoryName.toLowerCase()}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			result.push({ remote, info });
		}
		return result;
	}

	private async getAzdoRemoteInfos(): Promise<AzdoRemoteInfo[]> {
		return (await this.getAzdoRemotes()).map(entry => entry.info);
	}

	override async updateRepositories(silent: boolean = false, clearUserCache: boolean = false): Promise<boolean> {
		const remotes = await this.getAzdoRemotes();
		if (remotes.length === 0) {
			// No AzDO remotes: keep the GitHub behavior fully intact.
			return super.updateRepositories(silent, clearUserCache);
		}
		if (this._azdoUpdatingRepositories) {
			await this._azdoUpdatingRepositories;
		}
		this._azdoUpdatingRepositories = this.doUpdateAzdoRepositories(silent, remotes);
		return this._azdoUpdatingRepositories;
	}

	private async doUpdateAzdoRepositories(silent: boolean, remotes: { remote: Remote; info: AzdoRemoteInfo }[]): Promise<boolean> {
		this._azdoRemoteInfos = remotes.map(entry => entry.info);
		const infos = this._azdoRemoteInfos;

		// Silent credential attempt per organization; prompt once per session if missing.
		let authenticated = true;
		for (const orgUrl of new Set(infos.map(info => info.orgUrl))) {
			let connection = await this.azdoCredentialStore.getOrCreateConnection(orgUrl, { createIfNone: false });
			if (!connection && !this._azdoPromptedForAuth) {
				this._azdoPromptedForAuth = true;
				connection = await this.azdoCredentialStore.getOrCreateConnection(orgUrl, { createIfNone: true });
			}
			if (!connection) {
				authenticated = false;
			}
		}

		const oldRepositories = [...this.gitHubRepositories];
		const repositories: AzdoRepository[] = [];
		for (const { remote, info } of remotes) {
			const existing = oldRepositories.find(
				repo => repo instanceof AzdoRepository && repo.azdoRemoteInfo.orgUrl === info.orgUrl &&
					repo.azdoRemoteInfo.project === info.project && repo.azdoRemoteInfo.repositoryName === info.repositoryName,
			) as AzdoRepository | undefined;
			if (existing) {
				existing.gitRepository = this.repository;
				repositories.push(existing);
				continue;
			}
			const gitRemote = GitHubRemote.remoteAsGitHub(remote, GitHubServerType.None);
			const repository = new AzdoRepository(this._azdoRepositoryCounter++, info, gitRemote, this.repository.rootUri, this.azdoCredentialStore, this.credentialStore, this.telemetry);
			repository.gitRepository = this.repository;
			repositories.push(repository);
		}

		this._githubRepositories = repositories;
		this._allGitHubRemotes = repositories.map(repository => repository.remote);

		await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', true);

		const repositoriesAdded = repositories.some(repo => !oldRepositories.some(old => old.remote.equals(repo.remote)));
		if (repositoriesAdded) {
			this._onDidChangeGithubRepositories.fire(this._githubRepositories);
		}

		this.state = authenticated && repositories.length ? ReposManagerState.RepositoriesLoaded : ReposManagerState.NeedsAuthentication;

		if (!silent) {
			this._onDidChangeRepositories.fire({ added: repositoriesAdded });
		}
		return true;
	}

	override async getCurrentUser(githubRepository?: GitHubRepository): Promise<IAccount> {
		const azdoRepository = githubRepository instanceof AzdoRepository
			? githubRepository
			: this.gitHubRepositories.find(repository => repository instanceof AzdoRepository) as AzdoRepository | undefined;
		if (azdoRepository) {
			const identity = await azdoRepository.getAzdoIdentity();
			const accountProperty = (identity.properties?.['Account'] as { $value?: string } | undefined)?.$value;
			return convertIdentityRefToAccount({
				id: identity.id,
				displayName: identity.customDisplayName || identity.providerDisplayName,
				uniqueName: accountProperty,
			}, azdoRepository.azdoRemoteInfo.orgUrl);
		}
		return super.getCurrentUser(githubRepository);
	}

	/**
	 * Interactive sign-in for the `pr.signin*` commands. Returns true when all organizations
	 * now have credentials.
	 */
	public async signIn(): Promise<boolean> {
		const infos = this._azdoRemoteInfos.length ? this._azdoRemoteInfos : await this.getAzdoRemoteInfos();
		if (!infos.length) {
			return false;
		}
		this._azdoPromptedForAuth = true;
		for (const orgUrl of new Set(infos.map(info => info.orgUrl))) {
			const connection = await this.azdoCredentialStore.getOrCreateConnection(orgUrl, { createIfNone: true });
			if (!connection) {
				return false;
			}
		}
		await this.updateRepositories(false);
		return true;
	}

	public hasAzdoRemotes(): boolean {
		return this._azdoRemoteInfos.length > 0;
	}

	/**
	 * GitHub search queries are translated into AzDO search criteria. Only the tokens the
	 * AzDO API can express are honored (`author:@me`, `assignee:@me`,
	 * `review-requested:@me`); queries with unsupported concrete values resolve to an empty
	 * list rather than a wrong list.
	 */
	override async getPullRequestsForCategory(githubRepository: GitHubRepository, categoryQuery: string, page?: number): Promise<PullRequestData | undefined> {
		if (!(githubRepository instanceof AzdoRepository)) {
			return super.getPullRequestsForCategory(githubRepository, categoryQuery, page);
		}

		const criteria: GitPullRequestSearchCriteria = { status: PullRequestStatus.Active };
		const isMe = (value: string) => value === '@me' || /^\$\{user\}$/.test(value);
		let needsIdentity = false;
		for (const token of categoryQuery.split(/\s+/).filter(token => token.length > 0)) {
			const qualifier = token.substring(0, token.indexOf(':'));
			const value = token.substring(token.indexOf(':') + 1);
			switch (qualifier) {
				case 'author':
				case 'creator':
					if (isMe(value)) {
						needsIdentity = true;
					} else if (value) {
						return { items: [], hasMorePages: false };
					}
					break;
				case 'assignee':
				case 'review-requested':
				case 'reviewer':
					if (isMe(value)) {
						needsIdentity = true;
					} else if (value) {
						return { items: [], hasMorePages: false };
					}
					break;
				default:
					// `is:open`, `is:pr`, `repo:...` and other tokens either match the fixed
					// criteria above or are display-only; nothing to translate.
					break;
			}
		}

		if (needsIdentity) {
			const identity = await githubRepository.getAzdoIdentity().catch(() => undefined);
			if (!identity) {
				return { items: [], hasMorePages: false };
			}
			for (const token of categoryQuery.split(/\s+/).filter(token => token.length > 0)) {
				const qualifier = token.substring(0, token.indexOf(':'));
				const value = token.substring(token.indexOf(':') + 1);
				if (!isMe(value)) {
					continue;
				}
				if (qualifier === 'author' || qualifier === 'creator') {
					criteria.creatorId = identity.id;
				} else if (qualifier === 'assignee' || qualifier === 'review-requested' || qualifier === 'reviewer') {
					criteria.reviewerId = identity.id;
				}
			}
		}

		return githubRepository.getPullRequestsByCriteria(criteria, page ?? 1);
	}

	override async getLocalPullRequests(): Promise<PullRequestModel[]> {
		if (this._azdoRemoteInfos.length === 0) {
			return super.getLocalPullRequests();
		}

		if (!this.repository.getRefs) {
			return [];
		}

		const localBranches = (await this.repository.getRefs({ pattern: 'refs/heads/' }))
			.filter(ref => ref.name !== undefined)
			.map(ref => ref.name!);

		const models = await Promise.all(localBranches.map(async localBranchName => {
			const metadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this.repository, localBranchName);
			if (!metadata) {
				return undefined;
			}
			const azdoRepository = this.findAzdoRepository(metadata.owner, metadata.repositoryName);
			if (!azdoRepository) {
				return undefined;
			}
			const pullRequest = await azdoRepository.getPullRequest(metadata.prNumber, 'AzdoFolderRepositoryManager.getLocalPullRequests');
			if (pullRequest) {
				pullRequest.localBranchName = localBranchName;
			}
			return pullRequest;
		}));

		return models.filter((model): model is PullRequestModel => model !== undefined);
	}

	/**
	 * Resolves a pull request by organization and repository name. The base implementation
	 * matches remotes through the GitHub-flavoured `owner` (which is `_git` for AzDO URLs),
	 * so AzDO repositories are matched through their parsed remote info instead.
	 */
	override async resolvePullRequest(
		owner: string,
		repositoryName: string,
		pullRequestNumber: number,
		useCache: boolean = false,
		loadMode: 'default' | 'overview' = 'default',
	): Promise<PullRequestModel | undefined> {
		const azdoRepository = this.findAzdoRepository(owner, repositoryName);
		if (!azdoRepository) {
			return super.resolvePullRequest(owner, repositoryName, pullRequestNumber, useCache, loadMode);
		}
		return azdoRepository.getPullRequest(pullRequestNumber, 'AzdoFolderRepositoryManager.resolvePullRequest', useCache);
	}

	private findAzdoRepository(owner: string, repositoryName: string): AzdoRepository | undefined {
		const repository = this._githubRepositories.find(
			repo => repo instanceof AzdoRepository
				&& repo.azdoRemoteInfo.org.toLowerCase() === owner.toLowerCase()
				&& repo.azdoRemoteInfo.repositoryName.toLowerCase() === repositoryName.toLowerCase()) as AzdoRepository | undefined;
		return repository;
	}

	/**
	 * The base implementation enriches candidates through the GraphQL `hub`, which is inert
	 * for AzDO repositories (it throws `Call ensure() before accessing this property.`).
	 * AzDO branches are matched with a REST query on the pull-request source ref instead.
	 */
	override async getMatchingPullRequestMetadataFromGitHub(branch: Branch, remoteName?: string, remoteUrl?: string, upstreamBranchName?: string): Promise<
		(PullRequestMetadata & { model: PullRequestModel }) | null
	> {
		const azdoRepositories = this._githubRepositories.filter((repo): repo is AzdoRepository => repo instanceof AzdoRepository);
		if (azdoRepositories.length === 0) {
			return super.getMatchingPullRequestMetadataFromGitHub(branch, remoteName, remoteUrl, upstreamBranchName);
		}

		const candidates = remoteName
			? azdoRepositories.filter(repo => repo.remote.remoteName === remoteName)
			: azdoRepositories;
		if (candidates.length === 0) {
			// The remote belongs to a non-AzDO provider; keep the GitHub behavior intact.
			return super.getMatchingPullRequestMetadataFromGitHub(branch, remoteName, remoteUrl, upstreamBranchName);
		}

		const branchName = (upstreamBranchName ?? branch.name ?? '').replace(/^refs\/heads\//, '');
		if (!branchName) {
			return null;
		}

		Logger.debug(`Searching AzDO for a PR with source branch ${branchName}`, 'AzdoFolderRepositoryManager');
		for (const repository of candidates) {
			try {
				const result = await repository.getPullRequestsByCriteria({
					sourceRefName: `refs/heads/${branchName}`,
					status: PullRequestStatus.Active,
				});
				const first = result?.items[0];
				if (first) {
					return {
						owner: repository.azdoRemoteInfo.org,
						repositoryName: repository.azdoRemoteInfo.repositoryName,
						prNumber: first.number,
						model: first,
					};
				}
			} catch (e) {
				Logger.error(`Unable to get matching pull request metadata from AzDO: ${e}`, 'AzdoFolderRepositoryManager');
				return null;
			}
		}
		return null;
	}

	override async fetchAndCheckout(pullRequest: PullRequestModel, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
		if (!(pullRequest instanceof AzdoPullRequestModel) || this._azdoRemoteInfos.length === 0) {
			return super.fetchAndCheckout(pullRequest, progress);
		}

		const azdoRemotes: AzdoRemoteEntry[] = (await this.getAzdoRemotes()).map(entry => ({
			remoteName: entry.remote.remoteName,
			info: entry.info,
		}));
		await AzdoPullRequestGitHelper.fetchAndCheckout(this.repository, azdoRemotes, pullRequest, progress);
	}

	/**
	 * The AzDO REST item already carries all the head/base metadata; the GraphQL enrichment
	 * of the base class is replaced with a REST refresh when the model is missing data.
	 */
	override async fulfillPullRequestMissingInfo(pullRequest: PullRequestModel): Promise<void> {
		if (!(pullRequest instanceof AzdoPullRequestModel)) {
			return super.fulfillPullRequestMissingInfo(pullRequest);
		}

		if (!pullRequest.head?.sha) {
			try {
				const azdoRepository = pullRequest.githubRepository;
				if (azdoRepository instanceof AzdoRepository) {
					const refreshed = await azdoRepository.getAzdoPullRequest(pullRequest.number);
					if (refreshed) {
						azdoRepository.createOrUpdateAzdoModel(refreshed);
					}
				}
			} catch (e) {
				Logger.error(`Failed to refresh AzDO pull request ${pullRequest.number}: ${e instanceof Error ? e.message : String(e)}`, 'AzdoFolderRepositoryManager');
			}
		}

		if (!pullRequest.mergeBase) {
			pullRequest.mergeBase = pullRequest.azdoItem.lastMergeTargetCommit?.commitId ?? pullRequest.base?.sha;
		}
	}
}
