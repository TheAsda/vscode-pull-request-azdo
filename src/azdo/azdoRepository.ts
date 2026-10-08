/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitApi } from 'azure-devops-node-api/GitApi';
import { Comment, CommentThreadStatus, GitPullRequest, GitPullRequestCommentThread, GitPullRequestSearchCriteria, GitRepository, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { Identity } from 'azure-devops-node-api/interfaces/IdentitiesInterfaces';
import * as vscode from 'vscode';
import { AzdoConnection } from './azdoApi';
import { AzdoCredentialStore } from './credentials';
import { AzdoPullRequestModel } from './pullRequestModel';
import { AzdoRemoteInfo } from './remote';
import { convertAzdoPullRequestToItem, convertBranchRefToBranchName } from './utils';
import type { Repository } from '../api/api';
import { AuthenticationError } from '../common/authentication';
import Logger from '../common/logger';
import { GitHubRemote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { CredentialStore } from '../github/credentials';
import { GitHubRepository, PullRequestData } from '../github/githubRepository';
import type { PullRequestModel } from '../github/pullRequestModel';

export const AZDO_PR_PAGE_SIZE = 25;

/**
 * A GitHubRepository whose backing remote is an Azure DevOps repository.
 *
 * The GitHub-flavoured surface (octokit, GraphQL) is inert for AzDO remotes. Network calls
 * that the PR tree actually needs (`getAllPullRequests`, `getDefaultBranch`, identity) are
 * overridden against the Azure DevOps REST API via `azure-devops-node-api`, reusing the
 * shared `PullRequestData`/model machinery so the upstream tree renders AzDO PRs unchanged.
 */
export class AzdoRepository extends GitHubRepository {
	public readonly azdoRemoteInfo: AzdoRemoteInfo;

	private readonly _azdoCredentialStore: AzdoCredentialStore;
	private readonly _githubCredentialStore: CredentialStore;
	private _azdoConnection: AzdoConnection | undefined;
	private _azdoRepositoryId: string | undefined;
	private _azdoRepositoryMetadata: GitRepository | undefined;
	private _azdoIdentity: Identity | undefined;
	private readonly _azdoModels = new Map<number, AzdoPullRequestModel>();

	constructor(
		id: number,
		remoteInfo: AzdoRemoteInfo,
		remote: GitHubRemote,
		rootUri: vscode.Uri,
		azdoCredentialStore: AzdoCredentialStore,
		githubCredentialStore: CredentialStore,
		telemetry: ITelemetry,
	) {
		super(id, remote, rootUri, githubCredentialStore, telemetry, true /* silent: skip GitHub comments controller */);
		this.azdoRemoteInfo = remoteInfo;
		this._azdoCredentialStore = azdoCredentialStore;
		this._githubCredentialStore = githubCredentialStore;
	}

	override get authMatchesServer(): boolean {
		return this._azdoCredentialStore.isAuthenticated(this.azdoRemoteInfo.orgUrl);
	}

	/**
	 * Shared connection accessor. Never prompts unless `createIfNone` is set; throws
	 * `AuthenticationError` when no credentials are available.
	 */
	public async getAzdoConnection(): Promise<AzdoConnection> {
		if (this._azdoConnection) {
			return this._azdoConnection;
		}
		const connection = await this._azdoCredentialStore.getOrCreateConnection(this.azdoRemoteInfo.orgUrl, { createIfNone: false });
		if (!connection) {
			throw new AuthenticationError(vscode.l10n.t('Not signed in to Azure DevOps organization {0}', this.azdoRemoteInfo.orgUrl));
		}
		this._azdoConnection = connection;
		return connection;
	}

	override async ensure(): Promise<GitHubRepository> {
		await this.getAzdoConnection();
		return this;
	}

	public async getAzdoIdentity(): Promise<Identity> {
		if (this._azdoIdentity) {
			return this._azdoIdentity;
		}
		const connection = await this.getAzdoConnection();
		this._azdoIdentity = await connection.validate();
		return this._azdoIdentity;
	}

	public async getRepositoryMetadata(): Promise<GitRepository | undefined> {
		if (this._azdoRepositoryMetadata) {
			return this._azdoRepositoryMetadata;
		}
		const connection = await this.getAzdoConnection();
		const gitApi = await connection.api.getGitApi();
		const repositories = await gitApi.getRepositories(this.azdoRemoteInfo.project);
		const match = repositories?.find(repo => (repo.name ?? '').toLowerCase() === this.azdoRemoteInfo.repositoryName.toLowerCase());
		if (match) {
			this._azdoRepositoryMetadata = match;
			this._azdoRepositoryId = match.id;
		}
		return match;
	}

	public async getRepositoryId(): Promise<string | undefined> {
		if (this._azdoRepositoryId) {
			return this._azdoRepositoryId;
		}
		const metadata = await this.getRepositoryMetadata();
		return metadata?.id;
	}

	/**
	 * Core AzDO pull request query. `page` is 1-based, mirroring the GitHub paging contract.
	 */
	public async getPullRequestsByCriteria(criteria: GitPullRequestSearchCriteria, page: number = 1): Promise<PullRequestData | undefined> {
		try {
			Logger.debug(`Fetch AzDO pull requests (page ${page}) - enter`, 'AzdoRepository');
			const connection = await this.getAzdoConnection();
			const repositoryId = await this.getRepositoryId();
			if (!repositoryId) {
				Logger.appendLine(`AzDO repository ${this.azdoRemoteInfo.repositoryName} not found in project ${this.azdoRemoteInfo.project}`, 'AzdoRepository');
				return { items: [], hasMorePages: false };
			}
			const gitApi = await connection.api.getGitApi();
			const skip = (page - 1) * AZDO_PR_PAGE_SIZE;
			const results = await gitApi.getPullRequests(repositoryId, criteria, this.azdoRemoteInfo.project, undefined, skip, AZDO_PR_PAGE_SIZE);
			const items = (results ?? []).map(azdoItem => this.createOrUpdateAzdoModel(azdoItem));
			const hasMorePages = (results?.length ?? 0) === AZDO_PR_PAGE_SIZE;
			Logger.debug(`Fetch AzDO pull requests (page ${page}) - done (${items.length} items)`, 'AzdoRepository');
			return { items, hasMorePages };
		} catch (error) {
			if (error instanceof AuthenticationError) {
				throw error;
			}
			Logger.error(`Failed to fetch AzDO pull requests: ${error instanceof Error ? error.message : String(error)}`, 'AzdoRepository');
			return { items: [], hasMorePages: false };
		}
	}

	override async getAllPullRequests(page?: number): Promise<PullRequestData | undefined> {
		return this.getPullRequestsByCriteria({ status: PullRequestStatus.Active }, page ?? 1);
	}

	/**
	 * Creates or refreshes the cached model for an AzDO pull request. Mirrors the base class
	 * cache-by-number behavior, but produces `AzdoPullRequestModel`s that retain the raw
	 * AzDO item for later slices (threads, votes, statuses).
	 */
	public createOrUpdateAzdoModel(azdoItem: GitPullRequest): AzdoPullRequestModel {
		const number = azdoItem.pullRequestId ?? -1;
		const item = convertAzdoPullRequestToItem(azdoItem, this.azdoRemoteInfo);
		let model = this._azdoModels.get(number);
		if (model) {
			model.update(item);
		} else {
			model = new AzdoPullRequestModel(this._githubCredentialStore, this.telemetry, this, this.remote, item, azdoItem, this.azdoRemoteInfo);
			this._azdoModels.set(number, model);
		}
		return model;
	}

	/**
	 * Resolves a single pull request by id through the AzDO REST API, reusing the
	 * model cache. Mirrors `GitHubRepository.getPullRequest` for callers such as
	 * `FolderRepositoryManager.getLocalPullRequests` and `resolvePullRequest`.
	 */
	override async getPullRequest(id: number, _callerName: string, useCache: boolean = false): Promise<PullRequestModel | undefined> {
		if (useCache) {
			const cached = this._azdoModels.get(id);
			if (cached) {
				return cached;
			}
		}
		try {
			const azdoItem = await this.getAzdoPullRequest(id);
			if (!azdoItem) {
				return undefined;
			}
			return this.createOrUpdateAzdoModel(azdoItem);
		} catch (error) {
			if (error instanceof AuthenticationError) {
				throw error;
			}
			Logger.error(`Failed to resolve AzDO pull request ${id}: ${error instanceof Error ? error.message : String(error)}`, 'AzdoRepository');
			return undefined;
		}
	}

	/**
	 * Fetches the pull request with the given id as a raw AzDO item without touching the
	 * model cache. Returns `undefined` when the pull request cannot be found.
	 */
	public async getAzdoPullRequest(id: number): Promise<GitPullRequest | undefined> {
		try {
			const connection = await this.getAzdoConnection();
			const gitApi = await connection.api.getGitApi();
			return await gitApi.getPullRequestById(id, this.azdoRemoteInfo.project);
		} catch (error) {
			if (error instanceof AuthenticationError) {
				throw error;
			}
			Logger.error(`Failed to fetch AzDO pull request ${id}: ${error instanceof Error ? error.message : String(error)}`, 'AzdoRepository');
			return undefined;
		}
	}

	override async resolveRemote(): Promise<boolean> {
		// The AzDO remote is already fully parsed from the git URL; there is no metadata
		// round-trip needed to resolve owner/repo.
		return true;
	}

	/**
	 * The VS Code git extension `Repository` for the workspace folder this AzDO repository
	 * was discovered in. Set by the owning `AzdoFolderRepositoryManager`; models use it to
	 * compute file changes from local git.
	 */
	public gitRepository: Repository | undefined;

	private async getGitApiForComments(): Promise<{ gitApi: GitApi, repositoryId: string } | undefined> {
		const repositoryId = await this.getRepositoryId();
		if (!repositoryId) {
			Logger.appendLine(`AzDO repository ${this.azdoRemoteInfo.repositoryName} not found in project ${this.azdoRemoteInfo.project}`, 'AzdoRepository');
			return undefined;
		}
		const connection = await this.getAzdoConnection();
		const gitApi = await connection.api.getGitApi();
		return { gitApi, repositoryId };
	}

	/**
	 * Fetches all comment threads of a pull request.
	 */
	public async getAzdoThreads(pullRequestId: number): Promise<GitPullRequestCommentThread[]> {
		const commentsApi = await this.getGitApiForComments();
		if (!commentsApi) {
			return [];
		}
		const threads = await commentsApi.gitApi.getThreads(commentsApi.repositoryId, pullRequestId, this.azdoRemoteInfo.project);
		return threads ?? [];
	}

	/**
	 * Creates a new comment thread on a pull request.
	 */
	public async createAzdoThread(pullRequestId: number, thread: GitPullRequestCommentThread): Promise<GitPullRequestCommentThread> {
		const commentsApi = await this.getGitApiForComments();
		if (!commentsApi) {
			throw new Error(vscode.l10n.t('Unable to resolve Azure DevOps repository {0}', this.azdoRemoteInfo.repositoryName));
		}
		return commentsApi.gitApi.createThread(thread, commentsApi.repositoryId, pullRequestId, this.azdoRemoteInfo.project);
	}

	/**
	 * Adds a comment to an existing thread.
	 */
	public async createAzdoComment(pullRequestId: number, threadId: number, comment: Comment): Promise<Comment> {
		const commentsApi = await this.getGitApiForComments();
		if (!commentsApi) {
			throw new Error(vscode.l10n.t('Unable to resolve Azure DevOps repository {0}', this.azdoRemoteInfo.repositoryName));
		}
		return commentsApi.gitApi.createComment(comment, commentsApi.repositoryId, pullRequestId, threadId, this.azdoRemoteInfo.project);
	}

	/**
	 * Updates the status of a comment thread (e.g. resolves it as fixed).
	 */
	public async updateAzdoThreadStatus(pullRequestId: number, threadId: number, status: CommentThreadStatus): Promise<GitPullRequestCommentThread> {
		const commentsApi = await this.getGitApiForComments();
		if (!commentsApi) {
			throw new Error(vscode.l10n.t('Unable to resolve Azure DevOps repository {0}', this.azdoRemoteInfo.repositoryName));
		}
		return commentsApi.gitApi.updateThread({ status }, commentsApi.repositoryId, pullRequestId, threadId, this.azdoRemoteInfo.project);
	}

	override async getDefaultBranch(): Promise<string> {
		const metadata = await this.getRepositoryMetadata();
		return convertBranchRefToBranchName(metadata?.defaultBranch ?? 'refs/heads/main');
	}
}
