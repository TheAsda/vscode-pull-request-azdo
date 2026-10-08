/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { Comment, CommentThreadStatus, CommentType, GitPullRequest, GitPullRequestCommentThread, IdentityRefWithVote, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { parseAzdoRemoteUrl } from '../../azdo/remote';
import {
	absolutizeAvatarUrl,
	azdoCommentNodeId,
	azdoThreadId,
	buildPrBrowseUrl,
	convertAzdoPullRequestToItem,
	convertAzdoThreadToReviewThread,
	convertBranchRefToBranchName,
	convertIdentityRefToAccount,
	formatAzdoVoteSummary,
	getAzdoThreadPosition,
	parseAzdoCommentNodeId,
	parseAzdoThreadId,
	summarizeAzdoVotes,
} from '../../azdo/utils';

const REMOTE = parseAzdoRemoteUrl('https://dev.azure.com/contoso/MyProject/_git/MyRepo')!;

describe('azdo converters', () => {
	describe('convertBranchRefToBranchName', () => {
		it('strips refs/heads/', () => {
			assert.strictEqual(convertBranchRefToBranchName('refs/heads/feature/branch'), 'feature/branch');
		});

		it('strips refs/tags/ and refs/remotes/', () => {
			assert.strictEqual(convertBranchRefToBranchName('refs/tags/v1.0'), 'v1.0');
			assert.strictEqual(convertBranchRefToBranchName('refs/remotes/origin/main'), 'origin/main');
		});

		it('passes through plain branch names', () => {
			assert.strictEqual(convertBranchRefToBranchName('main'), 'main');
		});
	});

	describe('absolutizeAvatarUrl', () => {
		it('prefixes relative URLs with the org URL', () => {
			assert.strictEqual(
				absolutizeAvatarUrl('/_apis/GraphProfile/MemberAvatars/me', 'https://dev.azure.com/contoso'),
				'https://dev.azure.com/contoso/_apis/GraphProfile/MemberAvatars/me',
			);
		});

		it('keeps absolute URLs and empty values', () => {
			assert.strictEqual(absolutizeAvatarUrl('https://example.com/a.png', 'https://dev.azure.com/contoso'), 'https://example.com/a.png');
			assert.strictEqual(absolutizeAvatarUrl(undefined, 'https://dev.azure.com/contoso'), '');
		});
	});

	describe('convertIdentityRefToAccount', () => {
		it('maps uniqueName to login and absolutizes avatar', () => {
			const account = convertIdentityRefToAccount({
				id: 'guid-1',
				displayName: 'Ada Lovelace',
				uniqueName: 'ada@contoso.com',
				imageUrl: '/_apis/GraphProfile/MemberAvatars/ada',
				url: 'https://spscontoso.vssps.visualstudio.com/guid-1',
			}, 'https://dev.azure.com/contoso');
			assert.strictEqual(account.login, 'ada@contoso.com');
			assert.strictEqual(account.id, 'guid-1');
			assert.strictEqual(account.name, 'Ada Lovelace');
			assert.strictEqual(account.email, 'ada@contoso.com');
			assert.strictEqual(account.avatarUrl, 'https://dev.azure.com/contoso/_apis/GraphProfile/MemberAvatars/ada');
		});

		it('falls back to displayName when uniqueName is missing', () => {
			const account = convertIdentityRefToAccount({ id: 'guid-2', displayName: 'Build Service' }, 'https://dev.azure.com/contoso');
			assert.strictEqual(account.login, 'Build Service');
		});
	});

	describe('buildPrBrowseUrl', () => {
		it('builds organization-scoped pull request URL', () => {
			assert.strictEqual(
				buildPrBrowseUrl(REMOTE, 123),
				'https://dev.azure.com/contoso/MyProject/_git/MyRepo/pullrequest/123',
			);
		});
	});

	describe('convertAzdoPullRequestToItem', () => {
		it('maps an active pull request', () => {
			const item = convertAzdoPullRequestToItem({
				pullRequestId: 42,
				title: 'Add feature',
				description: 'The body',
				status: PullRequestStatus.Active,
				isDraft: true,
				createdBy: { id: 'guid-1', displayName: 'Ada', uniqueName: 'ada@contoso.com' },
				creationDate: new Date('2025-01-01T00:00:00Z'),
				sourceRefName: 'refs/heads/feature/x',
				targetRefName: 'refs/heads/main',
				lastMergeSourceCommit: { commitId: 'abc123' },
				lastMergeTargetCommit: { commitId: 'def456' },
				repository: { name: 'MyRepo', remoteUrl: 'https://dev.azure.com/contoso/MyProject/_git/MyRepo' },
			} as GitPullRequest, REMOTE);

			assert.strictEqual(item.number, 42);
			assert.strictEqual(item.state, 'open');
			assert.strictEqual(item.merged, false);
			assert.strictEqual(item.isDraft, true);
			assert.strictEqual(item.user.login, 'ada@contoso.com');
			assert.strictEqual(item.head!.ref, 'feature/x');
			assert.strictEqual(item.head!.sha, 'abc123');
			assert.strictEqual(item.head!.label, 'MyRepo:feature/x');
			assert.strictEqual(item.head!.repo.owner, 'contoso');
			assert.strictEqual(item.base!.ref, 'main');
			assert.strictEqual(item.url, 'https://dev.azure.com/contoso/MyProject/_git/MyRepo/pullrequest/42');
			assert.strictEqual(item.isRemoteHeadDeleted, false);
		});

		it('completed pull requests map to closed + merged', () => {
			const item = convertAzdoPullRequestToItem({
				pullRequestId: 43,
				title: 'Done',
				status: PullRequestStatus.Completed,
				creationDate: new Date('2025-01-01T00:00:00Z'),
				closedDate: new Date('2025-01-02T00:00:00Z'),
				sourceRefName: 'refs/heads/done',
				targetRefName: 'refs/heads/main',
			} as GitPullRequest, REMOTE);

			assert.strictEqual(item.state, 'closed');
			assert.strictEqual(item.merged, true);
			assert.strictEqual(item.updatedAt, '2025-01-02T00:00:00.000Z');
		});

		it('abandoned pull requests map to closed without merged', () => {
			const item = convertAzdoPullRequestToItem({
				pullRequestId: 44,
				title: 'Nope',
				status: PullRequestStatus.Abandoned,
				creationDate: new Date('2025-01-01T00:00:00Z'),
				sourceRefName: 'refs/heads/nope',
				targetRefName: 'refs/heads/main',
			} as GitPullRequest, REMOTE);

			assert.strictEqual(item.state, 'closed');
			assert.strictEqual(item.merged, false);
		});

		it('missing sourceRefName marks head deleted', () => {
			const item = convertAzdoPullRequestToItem({
				pullRequestId: 45,
				title: 'Deleted',
				status: PullRequestStatus.Active,
				creationDate: new Date('2025-01-01T00:00:00Z'),
				targetRefName: 'refs/heads/main',
			} as GitPullRequest, REMOTE);

			assert.strictEqual(item.isRemoteHeadDeleted, true);
			assert.strictEqual(item.head!.ref, '');
		});
	});

	describe('thread and comment ids', () => {
		it('round-trips thread ids', () => {
			assert.strictEqual(azdoThreadId(4711), 'azdo-4711');
			assert.strictEqual(parseAzdoThreadId('azdo-4711'), 4711);
			assert.strictEqual(parseAzdoThreadId('github-4711'), undefined);
			assert.strictEqual(parseAzdoThreadId('azdo-4711-8'), undefined);
		});

		it('round-trips comment node ids', () => {
			assert.strictEqual(azdoCommentNodeId(4711, 8), 'azdo-4711-8');
			assert.deepStrictEqual(parseAzdoCommentNodeId('azdo-4711-8'), { threadId: 4711, commentId: 8 });
			assert.strictEqual(parseAzdoCommentNodeId('azdo-4711'), undefined);
		});
	});

	describe('getAzdoThreadPosition', () => {
		it('prefers the right side from threadContext', () => {
			const position = getAzdoThreadPosition({
				threadContext: {
					filePath: '/src/file.ts',
					rightFileStart: { line: 10, offset: 1 },
					rightFileEnd: { line: 12, offset: 1 },
				},
			} as GitPullRequestCommentThread);
			assert.strictEqual(position.diffSide, 'RIGHT');
			assert.strictEqual(position.subjectType, 'LINE');
			assert.strictEqual(position.startLine, 10);
			assert.strictEqual(position.endLine, 12);
			assert.strictEqual(position.originalStartLine, 10);
			assert.strictEqual(position.originalEndLine, 12);
		});

		it('falls back to the left side when only leftFileStart is set', () => {
			const position = getAzdoThreadPosition({
				threadContext: {
					filePath: '/src/file.ts',
					leftFileStart: { line: 3, offset: 1 },
					leftFileEnd: { line: 4, offset: 1 },
				},
			} as GitPullRequestCommentThread);
			assert.strictEqual(position.diffSide, 'LEFT');
			assert.strictEqual(position.startLine, 3);
			assert.strictEqual(position.endLine, 4);
		});

		it('uses trackingCriteria as the original position', () => {
			const position = getAzdoThreadPosition({
				threadContext: {
					filePath: '/src/file.ts',
					rightFileStart: { line: 25, offset: 1 },
					rightFileEnd: { line: 25, offset: 1 },
				},
				pullRequestThreadContext: {
					trackingCriteria: {
						origRightFileStart: { line: 20, offset: 1 },
						origRightFileEnd: { line: 20, offset: 1 },
					},
				},
			} as GitPullRequestCommentThread);
			assert.strictEqual(position.startLine, 25);
			assert.strictEqual(position.originalStartLine, 20);
			assert.strictEqual(position.originalEndLine, 20);
		});

		it('treats threads without positions as file-level comments', () => {
			const position = getAzdoThreadPosition({
				threadContext: { filePath: '/src/file.ts' },
			} as GitPullRequestCommentThread);
			assert.strictEqual(position.subjectType, 'FILE');
			assert.strictEqual(position.startLine, 0);
			assert.strictEqual(position.endLine, 0);
		});
	});

	describe('reviewer votes', () => {
		const reviewer = (name: string, vote: number, isContainer = false): IdentityRefWithVote => ({
			displayName: name,
			uniqueName: `${name.toLowerCase()}@contoso.com`,
			id: name.toLowerCase(),
			vote,
			isContainer,
		});

		it('groups votes by value', () => {
			const summary = summarizeAzdoVotes([
				reviewer('Ada', 10),
				reviewer('Ben', 5),
				reviewer('Cy', -5),
				reviewer('Dee', -10),
				reviewer('Eve', 0),
			]);
			assert.deepStrictEqual(summary.approved, ['Ada']);
			assert.deepStrictEqual(summary.approvedWithSuggestions, ['Ben']);
			assert.deepStrictEqual(summary.waitingForAuthor, ['Cy']);
			assert.deepStrictEqual(summary.rejected, ['Dee']);
			assert.deepStrictEqual(summary.noVote, ['Eve']);
		});

		it('excludes group reviewers', () => {
			const summary = summarizeAzdoVotes([
				reviewer('[Team]', 10, true),
				reviewer('Ada', 10),
			]);
			assert.deepStrictEqual(summary.approved, ['Ada']);
		});

		it('formats a compact summary', () => {
			const text = formatAzdoVoteSummary([
				reviewer('Ada', 10),
				reviewer('Ben', 5),
				reviewer('Cy', -5),
			]);
			assert.strictEqual(text, 'Approved: Ada, Ben\nWaiting for author: Cy');
		});

		it('returns empty summary when nobody voted', () => {
			assert.strictEqual(formatAzdoVoteSummary([reviewer('Ada', 0)]), '');
			assert.strictEqual(formatAzdoVoteSummary([]), '');
		});
	});

	describe('convertAzdoThreadToReviewThread', () => {
		const comment = (id: number, content: string): Comment => ({
			id,
			content,
			commentType: CommentType.Text,
			author: { id: 'user-id', displayName: 'Ada Lovelace', uniqueName: 'ada@contoso.com' },
			publishedDate: new Date('2025-06-01T10:00:00Z'),
		});

		it('maps an active line thread with comments', () => {
			const thread = convertAzdoThreadToReviewThread({
				id: 4711,
				pullRequestId: 45,
				status: CommentThreadStatus.Active,
				threadContext: {
					filePath: '/src/file.ts',
					rightFileStart: { line: 10, offset: 1 },
					rightFileEnd: { line: 10, offset: 1 },
				},
				comments: [comment(8, 'Looks good')],
			} as GitPullRequestCommentThread, REMOTE);

			assert.strictEqual(thread.id, 'azdo-4711');
			assert.strictEqual(thread.isResolved, false);
			assert.strictEqual(thread.viewerCanResolve, true);
			assert.strictEqual(thread.viewerCanUnresolve, false);
			assert.strictEqual(thread.path, 'src/file.ts');
			assert.strictEqual(thread.diffSide, 'RIGHT');
			assert.strictEqual(thread.startLine, 10);
			assert.strictEqual(thread.comments.length, 1);
			assert.strictEqual(thread.comments[0].graphNodeId, 'azdo-4711-8');
			assert.strictEqual(thread.comments[0].threadId, 'azdo-4711');
			assert.strictEqual(thread.comments[0].position, 10);
			assert.strictEqual(thread.comments[0].user?.login, 'ada@contoso.com');
			assert.ok(thread.comments[0].htmlUrl.includes('pullrequest/45?_a=files&discussionId=4711'));
		});

		it('maps a fixed thread as resolved', () => {
			const thread = convertAzdoThreadToReviewThread({
				id: 4712,
				pullRequestId: 45,
				status: CommentThreadStatus.Fixed,
				threadContext: { filePath: '/src/file.ts' },
				comments: [comment(9, 'Fixed now')],
			} as GitPullRequestCommentThread, REMOTE);
			assert.strictEqual(thread.isResolved, true);
			assert.strictEqual(thread.viewerCanResolve, false);
			assert.strictEqual(thread.viewerCanUnresolve, true);
		});

		it('filters deleted comments and normalizes file paths', () => {
			const thread = convertAzdoThreadToReviewThread({
				id: 4713,
				pullRequestId: 45,
				status: CommentThreadStatus.Active,
				threadContext: { filePath: '\\src\\win.ts' },
				comments: [comment(10, 'kept'), { ...comment(11, 'deleted'), isDeleted: true }],
			} as GitPullRequestCommentThread, REMOTE);
			assert.strictEqual(thread.path, 'src/win.ts');
			assert.strictEqual(thread.subjectType, 'FILE');
			assert.strictEqual(thread.comments.length, 1);
			assert.strictEqual(thread.comments[0].body, 'kept');
			assert.strictEqual(thread.comments[0].position, undefined);
		});
	});
});
