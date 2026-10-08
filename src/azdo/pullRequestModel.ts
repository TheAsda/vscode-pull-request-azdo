/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AzdoRemoteInfo } from './remote';
import { convertAzdoPullRequestToItem } from './utils';
import { Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { CredentialStore } from '../github/credentials';
import { GitHubRepository } from '../github/githubRepository';
import { PullRequest } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';

/**
 * A `PullRequestModel` backed by an Azure DevOps pull request. The GitHub-shaped `item` is
 * produced by `convertAzdoPullRequestToItem`; the raw AzDO payload is retained so later
 * slices (threads, votes, statuses, policies) can enrich the model without refetching.
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
}
