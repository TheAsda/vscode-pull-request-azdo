/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IdentityRef } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { GitPullRequest, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
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
