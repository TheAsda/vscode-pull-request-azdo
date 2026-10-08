/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CommentType, GitPullRequest, GitPullRequestCommentThread, IdentityRefWithVote } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { AzdoRepository } from './azdoRepository';
import { AzdoRemoteInfo } from './remote';
import {
	convertAzdoPullRequestToItem,
	convertAzdoThreadToReviewThread,
	formatAzdoVoteSummary,
	parseAzdoCommentNodeId,
	parseAzdoThreadId,
} from './utils';
import { Change, Repository } from '../api/api';
import { Status } from '../api/api1';
import { DiffSide, IComment, IReviewThread } from '../common/comment';
import { GitChangeType, InMemFileChange, SlimFileChange } from '../common/file';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { ReviewEvent } from '../common/timelineEvent';
import { CredentialStore } from '../github/credentials';
import { GitHubRepository } from '../github/githubRepository';
import { PullRequest, ReviewEventEnum } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';

/**
 * A `PullRequestModel` backed by an Azure DevOps pull request. The GitHub-shaped `item` is
 * produced by `convertAzdoPullRequestToItem`; the raw AzDO payload is retained so later
 * slices (threads, votes, statuses, policies) can enrich the model without refetching.
 *
 * Review-mode surfaces are computed from local git: after checkout the merge base is an
 * ancestor of HEAD, so the changed-file list and diffs need no round-trip through AzDO.
 */
export class AzdoPullRequestModel extends PullRequestModel {
	public azdoItem: GitPullRequest;
	public readonly azdoRemoteInfo: AzdoRemoteInfo;

	constructor(
		credentialStore: CredentialStore,
		telemetry: ITelemetry,
		githubRepository: GitHubRepository,
		remote: Remote,
		item: PullRequest,
		azdoItem: GitPullRequest,
		remoteInfo: AzdoRemoteInfo,
		isActive?: boolean,
	) {
		super(credentialStore, telemetry, githubRepository, remote, item, isActive);
		this.azdoItem = azdoItem;
		this.azdoRemoteInfo = remoteInfo;
	}

	/**
	 * Refreshes both the GitHub-shaped item and the retained AzDO payload.
	 */
	public updateAzdoItem(azdoItem: GitPullRequest, item?: PullRequest): void {
		this.azdoItem = azdoItem;
		this.update(item ?? convertAzdoPullRequestToItem(azdoItem, this.azdoRemoteInfo));
	}

	private get azdoRepository(): AzdoRepository | undefined {
		return this.githubRepository instanceof AzdoRepository ? this.githubRepository : undefined;
	}

	// #region File changes

	/**
	 * Computes the changed files of the pull request from local git. Only the active
	 * (checked out) pull request is supported: the merge base is an ancestor of HEAD and
	 * therefore available locally, and both content sides of every diff resolve from the
	 * object database without touching AzDO.
	 */
	override async getFileChangesInfo(): Promise<(InMemFileChange | SlimFileChange)[]> {
		this._fileChanges.clear();
		const repository = this.azdoRepository?.gitRepository;
		if (!this.isActive || !repository || !this.head?.sha || !this.azdoItem.targetRefName) {
			return [];
		}

		try {
			// The merge base is advisory: when it cannot be computed (missing target ref,
			// corrupted object, interrupted fetch) fall back to the target tip instead of
			// emptying the file list - the diff just becomes noisier, not wrong.
			const mergeBase = (await this.ensureLocalMergeBase(repository)) ?? this.base?.sha;
			if (!mergeBase) {
				return [];
			}
			const changes = await repository.diffBetween(mergeBase, this.head.sha);
			const slimChanges = changes.map(change => this.convertLocalChange(change, mergeBase));
			for (const change of slimChanges) {
				this._fileChanges.set(change.fileName, change);
			}
			return slimChanges;
		} catch (e) {
			Logger.error(`Failed to compute AzDO pull request file changes: ${e}`, 'AzdoPullRequestModel');
			return [];
		}
	}

	/**
	 * Fetches the pull request target branch and computes the merge base between it and the
	 * locally checked out head. The merge base commit itself is an ancestor of HEAD and
	 * therefore already present locally; only the target ref has to be fetched.
	 */
	private async ensureLocalMergeBase(repository: Repository): Promise<string | undefined> {
		const azdoRepository = this.azdoRepository;
		const targetRefName = this.azdoItem.targetRefName;
		if (!azdoRepository || !targetRefName || !this.head?.sha) {
			return undefined;
		}

		const targetBranch = targetRefName.replace(/^refs\/heads\//, '');
		const remoteName = azdoRepository.azdoRemoteInfo.remoteName;
		const localTargetRef = `refs/remotes/${remoteName}/${targetBranch}`;
		try {
			await repository.fetch(remoteName, targetBranch);
		} catch (e) {
			Logger.warn(`Failed to fetch AzDO target branch ${targetRefName}: ${e}`, 'AzdoPullRequestModel');
		}
		try {
			const mergeBase = await repository.getMergeBase(this.head.sha, localTargetRef);
			if (mergeBase) {
				this.mergeBase = mergeBase;
				return mergeBase;
			}
		} catch (e) {
			Logger.warn(`Failed to compute merge base for AzDO pull request ${this.number}: ${e}`, 'AzdoPullRequestModel');
		}
		return this.mergeBase ?? this.base?.sha;
	}

	private convertLocalChange(change: Change, mergeBase: string): SlimFileChange {
		const repository = this.azdoRepository!.gitRepository!;
		const relative = (uri: vscode.Uri): string => {
			const root = repository.rootUri.path.replace(/\/$/, '');
			const path = uri.path.replace(/\/$/, '');
			return path.startsWith(root) ? path.substring(root.length + 1) : path;
		};
		const fileName = relative(change.uri);
		const previousFileName = change.renameUri ? relative(change.originalUri) : undefined;

		let status: GitChangeType;
		switch (change.status) {
			case Status.INDEX_ADDED:
			case Status.ADDED_BY_US:
			case Status.ADDED_BY_THEM:
			case Status.BOTH_ADDED:
			case Status.UNTRACKED:
			case Status.INTENT_TO_ADD:
				status = GitChangeType.ADD;
				break;
			case Status.INDEX_DELETED:
			case Status.DELETED:
			case Status.DELETED_BY_US:
			case Status.DELETED_BY_THEM:
			case Status.BOTH_DELETED:
				status = GitChangeType.DELETE;
				break;
			case Status.INDEX_RENAMED:
			case Status.INDEX_COPIED:
				status = GitChangeType.RENAME;
				break;
			default:
				status = GitChangeType.MODIFY;
				break;
		}
		return new SlimFileChange(mergeBase, '', status, fileName, previousFileName);
	}

	// #endregion

	// #region Comment threads

	/**
	 * Loads all AzDO comment threads into the review-thread cache. The base implementation
	 * of `initializeReviewThreadCacheAndReviewComments` then derives `this.comments` from
	 * the returned threads, so file nodes and comment controllers light up unchanged.
	 */
	override async initializeReviewThreadCache(): Promise<IReviewThread[]> {
		const azdoRepository = this.azdoRepository;
		if (!azdoRepository) {
			this._reviewThreadsCache = [];
			this._reviewThreadsCacheInitialized = true;
			return [];
		}
		let reviewThreads: IReviewThread[] = [];
		try {
			const rawThreads = await azdoRepository.getAzdoThreads(this.number);
			reviewThreads = rawThreads
				.filter(thread => !thread.isDeleted)
				.map(thread => convertAzdoThreadToReviewThread(thread, this.azdoRemoteInfo));
		} catch (e) {
			Logger.error(`Failed to fetch AzDO comment threads for PR #${this.number}: ${e}`, 'AzdoPullRequestModel');
		}
		const oldReviewThreads = this._reviewThreadsCache ?? [];
		this._reviewThreadsCache = reviewThreads;
		this._reviewThreadsCacheInitialized = true;
		this.diffThreads(oldReviewThreads, reviewThreads);
		return reviewThreads;
	}

	override async createReviewThread(
		body: string,
		commentPath: string,
		startLine: number | undefined,
		endLine: number | undefined,
		side: DiffSide,
		_suppressDraftModeUpdate?: boolean,
		anchoring?: { startOffset: number; endOffset: number },
	): Promise<IReviewThread | undefined> {
		if (!this.validatePullRequestModel('Creating comment failed')) {
			return undefined;
		}
		const azdoRepository = this.azdoRepository;
		if (!azdoRepository) {
			throw new Error('Creating comment failed: not backed by an Azure DevOps repository.');
		}

		const isFileComment = startLine === undefined || endLine === undefined || startLine === 0 || endLine === 0;
		const endLineResolved = endLine ?? startLine;
		// VS Code selection characters are 0-based, AzDO thread context offsets are 1-based.
		// Without an explicit anchoring (gutter click, suggestion block) anchor the whole
		// line so the thread never collapses to a zero-width range in the web UI.
		const startOffset = anchoring?.startOffset ?? 1;
		const endOffset = anchoring?.endOffset ?? Math.max(1, startOffset);
		const threadContext: GitPullRequestCommentThread['threadContext'] = isFileComment
			? { filePath: `/${commentPath.replace(/^\//, '')}` }
			: side === DiffSide.LEFT
				? {
					filePath: `/${commentPath.replace(/^\//, '')}`,
					leftFileStart: { line: startLine, offset: startOffset },
					leftFileEnd: { line: endLineResolved, offset: endOffset },
				}
				: {
					filePath: `/${commentPath.replace(/^\//, '')}`,
					rightFileStart: { line: startLine, offset: startOffset },
					rightFileEnd: { line: endLineResolved, offset: endOffset },
				};

		const created = await azdoRepository.createAzdoThread(this.number, {
			status: 1 /* CommentThreadStatus.Active */,
			threadContext,
			comments: [{ content: body, commentType: CommentType.Text, parentCommentId: 0 }],
		});

		const newThread = convertAzdoThreadToReviewThread(created, this.azdoRemoteInfo);
		if (!this._reviewThreadsCache) {
			this._reviewThreadsCache = [];
		}
		this._reviewThreadsCache.push(newThread);
		this._onDidChangeReviewThreads.fire({ added: [newThread], changed: [], removed: [] });
		this._onDidChange.fire({ timeline: true });
		return newThread;
	}

	override async createCommentReply(
		body: string,
		inReplyTo: string,
		_isSingleComment: boolean,
		_commitId?: string,
	): Promise<IComment | undefined> {
		if (!this.validatePullRequestModel('Creating comment failed')) {
			return undefined;
		}
		const azdoRepository = this.azdoRepository;
		const replyTarget = parseAzdoCommentNodeId(inReplyTo);
		if (!azdoRepository || !replyTarget) {
			throw new Error('Creating comment reply failed: unknown reply target.');
		}

		const created = await azdoRepository.createAzdoComment(this.number, replyTarget.threadId, {
			content: body,
			commentType: CommentType.Text,
		});

		const threadWithComment = this._reviewThreadsCache?.find(
			thread => parseAzdoThreadId(thread.id) === replyTarget.threadId,
		);
		if (!threadWithComment || !threadWithComment.comments.length) {
			return undefined;
		}
		const rawThread = await azdoRepository.getAzdoThreads(this.number);
		const refreshed = rawThread
			.filter(thread => thread.id === replyTarget.threadId)
			.map(thread => convertAzdoThreadToReviewThread(thread, this.azdoRemoteInfo))[0];
		if (refreshed) {
			const index = this._reviewThreadsCache!.indexOf(threadWithComment);
			if (index >= 0) {
				this._reviewThreadsCache![index] = refreshed;
			}
			this._onDidChangeReviewThreads.fire({ added: [], changed: [refreshed], removed: [] });
		}
		this._onDidChange.fire({ timeline: true, comments: true });
		return refreshed?.comments.find(comment => comment.id === created.id);
	}

	override async resolveReviewThread(threadId: string): Promise<void> {
		await this.updateAzdoThreadStatus(threadId, 2 /* CommentThreadStatus.Fixed */);
	}

	override async unresolveReviewThread(threadId: string): Promise<void> {
		await this.updateAzdoThreadStatus(threadId, 1 /* CommentThreadStatus.Active */);
	}

	private async updateAzdoThreadStatus(threadId: string, status: number): Promise<void> {
		const azdoRepository = this.azdoRepository;
		const id = parseAzdoThreadId(threadId);
		if (!azdoRepository || id === undefined) {
			return;
		}
		const updated = await azdoRepository.updateAzdoThreadStatus(this.number, id, status);
		const refreshed = convertAzdoThreadToReviewThread(updated, this.azdoRemoteInfo);
		const index = this._reviewThreadsCache?.findIndex(thread => thread.id === refreshed.id) ?? -1;
		if (index >= 0 && this._reviewThreadsCache) {
			this._reviewThreadsCache[index] = refreshed;
			this._onDidChangeReviewThreads.fire({ added: [], changed: [refreshed], removed: [] });
		}
	}

	// #endregion

	// #region Draft review mode (not applicable to AzDO)

	/**
	 * AzDO has no GitHub-style pending review: every comment is published immediately.
	 */
	override async validateDraftMode(): Promise<boolean> {
		if (this.hasPendingReview) {
			this.hasPendingReview = false;
		}
		return false;
	}

	override async getPendingReviewId(): Promise<string | undefined> {
		return undefined;
	}

	override async startReview(_commitId?: string): Promise<string> {
		return '';
	}

	/**
	 * AzDO has no pending reviews to submit; every comment is published immediately on
	 * creation, so submitting is a no-op that reports success.
	 */
	override async submitReview(_event?: ReviewEventEnum, _body?: string): Promise<ReviewEvent> {
		return { eventId: -1, prNumber: this.number } as unknown as ReviewEvent;
	}

	/**
	 * File viewed state is a GitHub-only concept; skip the GraphQL round-trip.
	 */
	override async initializePullRequestFileViewState(): Promise<void> {
		// no-op
	}

	// #endregion

	// #region Reviewer votes

	/**
	 * Refreshes the retained reviewers (and their votes) from the service.
	 */
	public async refreshAzdoReviewers(): Promise<IdentityRefWithVote[]> {
		const azdoRepository = this.azdoRepository;
		if (!azdoRepository) {
			return [];
		}
		const reviewers = await azdoRepository.getAzdoReviewers(this.number);
		this.azdoItem = { ...this.azdoItem, reviewers };
		return reviewers;
	}

	/**
	 * Submits a vote on behalf of the signed-in user and updates the retained reviewers.
	 */
	public async submitVote(vote: number): Promise<IdentityRefWithVote | undefined> {
		const azdoRepository = this.azdoRepository;
		if (!azdoRepository) {
			return undefined;
		}
		const identity = await azdoRepository.getAzdoIdentity();
		if (!identity?.id) {
			throw new Error(vscode.l10n.t('Not signed in to Azure DevOps organization {0}', azdoRepository.azdoRemoteInfo.orgUrl));
		}
		const result = await azdoRepository.submitAzdoVote(this.number, identity.id, vote);
		// Merge the returned vote into the retained reviewers so tooltips stay current.
		const reviewers = [...(this.azdoItem.reviewers ?? [])];
		const index = reviewers.findIndex(reviewer => reviewer.id === identity.id);
		if (index >= 0) {
			reviewers[index] = { ...reviewers[index], vote: result.vote };
		} else {
			reviewers.push(result);
		}
		this.azdoItem = { ...this.azdoItem, reviewers };
		this._onDidChange.fire({ timeline: true });
		return result;
	}

	/**
	 * Multi-line vote summary for tree tooltips. Empty when no reviewer has voted.
	 */
	public getVoteSummary(): string {
		return formatAzdoVoteSummary(this.azdoItem.reviewers ?? []);
	}

	// #endregion
}
