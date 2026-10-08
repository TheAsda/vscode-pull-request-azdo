/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IdentityRef } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { Comment, CommentThreadStatus, GitPullRequest, GitPullRequestCommentThread, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AzdoRemoteInfo } from './remote';
import type { AccountType, IAccount, IGitHubRef, PullRequest } from '../github/interface';

/** String enum values of `AccountType` (type-only import keeps this module node-testable). */
const ACCOUNT_TYPE_USER = 'User' as unknown as AccountType;

/**
 * Converts a full git ref (`refs/heads/foo/bar`) into a plain branch name (`foo/bar`).
 */
export function convertBranchRefToBranchName(branchRef: string): string {
	const splitRef = branchRef.split('/');
	if (splitRef.length < 2) {
		return branchRef;
	}
	if (splitRef[1] === 'heads' || splitRef[1] === 'tags' || splitRef[1] === 'remotes') {
		return splitRef.slice(2).join('/');
	}
	return splitRef.slice(1).join('/');
}

/**
 * IdentityRef image URLs are usually relative (`/_apis/GraphProfile/MemberAvatars/...`).
 * Absolutizes them against the organization URL so they can be rendered.
 */
export function absolutizeAvatarUrl(avatarUrl: string | undefined, orgUrl: string): string {
	if (!avatarUrl) {
		return '';
	}
	if (/^https?:\/\//i.test(avatarUrl)) {
		return avatarUrl;
	}
	return `${orgUrl.replace(/\/$/, '')}/${avatarUrl.replace(/^\//, '')}`;
}

/**
 * Maps an Azure DevOps identity into the account shape used by the shared GitHub models.
 */
export function convertIdentityRefToAccount(identity: IdentityRef, orgUrl: string): IAccount {
	return {
		login: identity.uniqueName || identity.displayName || identity.id || 'unknown',
		id: identity.id || '',
		name: identity.displayName,
		avatarUrl: absolutizeAvatarUrl(identity.imageUrl, orgUrl),
		url: identity.url || orgUrl,
		email: identity.uniqueName?.includes('@') ? identity.uniqueName : undefined,
		accountType: ACCOUNT_TYPE_USER,
	};
}

/**
 * Browser URL for a pull request: {orgUrl}/{project}/_git/{repo}/pullrequest/{id}
 */
export function buildPrBrowseUrl(remoteInfo: AzdoRemoteInfo, pullRequestId: number): string {
	const orgUrl = remoteInfo.orgUrl.replace(/\/$/, '');
	return `${orgUrl}/${encodeURIComponent(remoteInfo.project)}/_git/${encodeURIComponent(remoteInfo.repositoryName)}/pullrequest/${pullRequestId}`;
}

function toItemState(status: PullRequestStatus | undefined): string {
	switch (status) {
		case PullRequestStatus.Completed:
		case PullRequestStatus.Abandoned:
			return 'closed';
		default:
			return 'open';
	}
}

function toRef(
	refName: string | undefined,
	sha: string | undefined,
	repositoryName: string,
	cloneUrl: string,
	owner: string,
	remoteDeleted: boolean,
): IGitHubRef {
	const branchName = convertBranchRefToBranchName(refName || '');
	return {
		label: `${repositoryName}:${branchName}`,
		ref: branchName,
		sha: sha || '',
		repo: {
			cloneUrl,
			owner,
			name: repositoryName,
			isInOrganization: false,
		},
		...((remoteDeleted ? { exists: false } : {}) as object),
	};
}

/**
 * Converts an Azure DevOps `GitPullRequest` into the GitHub `PullRequest` item shape consumed
 * by the shared model layer. All web-only fields (commits, reactions, projects) are stubbed;
 * they are only reachable through flows this port does not use.
 */
export function convertAzdoPullRequestToItem(
	pullRequest: GitPullRequest,
	remoteInfo: AzdoRemoteInfo,
): PullRequest {
	const orgUrl = remoteInfo.orgUrl;
	const repositoryName = pullRequest.repository?.name || remoteInfo.repositoryName;
	const cloneUrl = pullRequest.repository?.remoteUrl || remoteInfo.url;
	const createdAt = pullRequest.creationDate?.toISOString() ?? new Date().toISOString();
	const updatedAt = (pullRequest.closedDate ?? pullRequest.creationDate)?.toISOString() ?? createdAt;
	const isCompleted = pullRequest.status === PullRequestStatus.Completed;

	return {
		id: pullRequest.pullRequestId ?? 0,
		graphNodeId: `azdo-pullrequest-${remoteInfo.org}-${remoteInfo.project}-${pullRequest.pullRequestId ?? 0}`,
		number: pullRequest.pullRequestId ?? 0,
		title: pullRequest.title ?? '',
		titleHTML: pullRequest.title ?? '',
		body: pullRequest.description ?? '',
		url: buildPrBrowseUrl(remoteInfo, pullRequest.pullRequestId ?? 0),
		user: pullRequest.createdBy ? convertIdentityRefToAccount(pullRequest.createdBy, orgUrl) : {
			login: 'unknown',
			id: '',
			url: orgUrl,
			accountType: ACCOUNT_TYPE_USER,
		},
		state: toItemState(pullRequest.status),
		merged: isCompleted,
		assignees: pullRequest.reviewers?.map(reviewer => convertIdentityRefToAccount(reviewer, orgUrl)),
		createdAt,
		updatedAt,
		viewerCanUpdate: true,
		head: toRef(
			pullRequest.sourceRefName,
			pullRequest.lastMergeSourceCommit?.commitId,
			repositoryName,
			cloneUrl,
			remoteInfo.org,
			pullRequest.sourceRefName === undefined,
		),
		isRemoteHeadDeleted: pullRequest.sourceRefName === undefined,
		base: toRef(
			pullRequest.targetRefName,
			pullRequest.lastMergeTargetCommit?.commitId,
			repositoryName,
			cloneUrl,
			remoteInfo.org,
			pullRequest.targetRefName === undefined,
		),
		isRemoteBaseDeleted: pullRequest.targetRefName === undefined,
		labels: [],
		isDraft: pullRequest.isDraft ?? false,
		suggestedReviewers: [],
		projectItems: [],
		commits: [],
		reactionCount: 0,
		reactions: [],
		commentCount: 0,
	};
}

/**
 * Extracts the trailing `{orgUrl}/{project}/_git/{repo}/pullrequest/{id}` info for display.
 */
export function getAzdoPrNumber(pullRequest: GitPullRequest): number {
	return pullRequest.pullRequestId ?? -1;
}

// #region Pull request comment threads

/** String enum values of `DiffSide`/`SubjectType` (type-only import keeps this module node-testable). */
const DIFF_SIDE_LEFT = 'LEFT' as unknown as import('../common/comment').DiffSide;
const DIFF_SIDE_RIGHT = 'RIGHT' as unknown as import('../common/comment').DiffSide;
const SUBJECT_TYPE_LINE = 'LINE' as unknown as import('../common/comment').SubjectType;
const SUBJECT_TYPE_FILE = 'FILE' as unknown as import('../common/comment').SubjectType;

/** Stable thread id used across the upstream review-thread machinery. */
export function azdoThreadId(threadId: number): string {
	return `azdo-${threadId}`;
}

export function parseAzdoThreadId(threadId: string): number | undefined {
	const match = /^azdo-(\d+)$/.exec(threadId);
	return match ? Number(match[1]) : undefined;
}

/** Stable comment node id (`graphNodeId` equivalent), also used as the reply-to key. */
export function azdoCommentNodeId(threadId: number, commentId: number): string {
	return `azdo-${threadId}-${commentId}`;
}

export function parseAzdoCommentNodeId(nodeId: string): { threadId: number; commentId: number } | undefined {
	const match = /^azdo-(\d+)-(\d+)$/.exec(nodeId);
	return match ? { threadId: Number(match[1]), commentId: Number(match[2]) } : undefined;
}

function normalizeAzdoFilePath(filePath: string | undefined): string {
	if (!filePath) {
		return '';
	}
	return filePath.replace(/\\/g, '/').replace(/^\//, '');
}

export interface AzdoThreadPosition {
	diffSide: import('../common/comment').DiffSide;
	subjectType: import('../common/comment').SubjectType;
	startLine: number;
	endLine: number;
	originalStartLine: number;
	originalEndLine: number;
}

/**
 * Computes the upstream review-thread position fields for an AzDO comment thread.
 * AzDO tracks positions on both file sides (`threadContext` = current tracked position,
 * `pullRequestThreadContext.trackingCriteria` = original position at creation); upstream
 * only models one side per thread, so the right side wins when both are present.
 */
export function getAzdoThreadPosition(thread: GitPullRequestCommentThread): AzdoThreadPosition {
	const context = thread.threadContext;
	const tracking = thread.pullRequestThreadContext?.trackingCriteria;
	const rightStart = context?.rightFileStart ?? tracking?.origRightFileStart;
	const leftStart = context?.leftFileStart ?? tracking?.origLeftFileStart;

	if (!rightStart && !leftStart) {
		// File-level comment: no line position at all.
		return {
			diffSide: DIFF_SIDE_RIGHT,
			subjectType: SUBJECT_TYPE_FILE,
			startLine: 0,
			endLine: 0,
			originalStartLine: 0,
			originalEndLine: 0,
		};
	}

	const onRight = !!rightStart;
	const contextStart = onRight ? context?.rightFileStart : context?.leftFileStart;
	const contextEnd = onRight ? context?.rightFileEnd : context?.leftFileEnd;
	const originalStart = onRight ? tracking?.origRightFileStart : tracking?.origLeftFileStart;
	const originalEnd = onRight ? tracking?.origRightFileEnd : tracking?.origLeftFileEnd;

	const startLine = contextStart?.line ?? originalStart?.line ?? 0;
	const endLine = contextEnd?.line ?? originalEnd?.line ?? startLine;
	return {
		diffSide: onRight ? DIFF_SIDE_RIGHT : DIFF_SIDE_LEFT,
		subjectType: SUBJECT_TYPE_LINE,
		startLine,
		endLine,
		originalStartLine: originalStart?.line ?? startLine,
		originalEndLine: originalEnd?.line ?? endLine,
	};
}

function isAzdoThreadResolved(status: CommentThreadStatus | undefined): boolean {
	switch (status) {
		case CommentThreadStatus.Fixed:
		case CommentThreadStatus.WontFix:
		case CommentThreadStatus.ByDesign:
		case CommentThreadStatus.Closed:
			return true;
		default:
			return false;
	}
}

/**
 * Maps an AzDO thread comment onto the upstream `IComment` shape.
 */
export function convertAzdoCommentToIComment(
	comment: Comment,
	thread: GitPullRequestCommentThread,
	remoteInfo: AzdoRemoteInfo,
): import('../common/comment').IComment {
	const threadId = thread.id ?? 0;
	const commentId = comment.id ?? 0;
	const prUrl = buildPrBrowseUrl(remoteInfo, getAzdoPrNumberFromThread(thread));
	const discussionUrl = `${prUrl}?_a=files&discussionId=${threadId}`;
	const position = getAzdoThreadPosition(thread);
	return {
		id: commentId,
		graphNodeId: azdoCommentNodeId(threadId, commentId),
		url: discussionUrl,
		htmlUrl: discussionUrl,
		body: comment.content ?? '',
		createdAt: (comment.publishedDate ?? new Date()).toISOString(),
		user: comment.author ? convertIdentityRefToAccount(comment.author, remoteInfo.orgUrl) : undefined,
		path: normalizeAzdoFilePath(thread.threadContext?.filePath),
		position: position.subjectType === SUBJECT_TYPE_LINE ? position.startLine : undefined,
		diffHunk: '',
		canEdit: false,
		canDelete: false,
		isDraft: false,
		isOutdated: false,
		threadId: azdoThreadId(threadId),
	};
}

/**
 * Maps an AzDO pull request comment thread onto the upstream `IReviewThread` shape so the
 * stock review comment controllers render it without modification.
 */
export function convertAzdoThreadToReviewThread(
	thread: GitPullRequestCommentThread,
	remoteInfo: AzdoRemoteInfo,
): import('../common/comment').IReviewThread {
	const position = getAzdoThreadPosition(thread);
	const isResolved = isAzdoThreadResolved(thread.status);
	return {
		id: azdoThreadId(thread.id ?? 0),
		prReviewDatabaseId: thread.id,
		isResolved,
		viewerCanResolve: !isResolved,
		viewerCanUnresolve: isResolved,
		path: normalizeAzdoFilePath(thread.threadContext?.filePath),
		diffSide: position.diffSide,
		startLine: position.startLine,
		endLine: position.endLine,
		originalStartLine: position.originalStartLine,
		originalEndLine: position.originalEndLine,
		isOutdated: false,
		subjectType: position.subjectType,
		comments: (thread.comments ?? [])
			.filter(comment => !comment.isDeleted)
			.map(comment => convertAzdoCommentToIComment(comment, thread, remoteInfo)),
	};
}

function getAzdoPrNumberFromThread(thread: GitPullRequestCommentThread): number {
	return (thread as unknown as { pullRequestId?: number }).pullRequestId ?? 0;
}

// #endregion
