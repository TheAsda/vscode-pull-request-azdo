/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AzdoPullRequestModel } from './pullRequestModel';
import { AzdoRemoteInfo } from './remote';
import { convertBranchRefToBranchName } from './utils';
import { Repository } from '../api/api';
import Logger from '../common/logger';
import { PullRequestGitHelper } from '../github/pullRequestGitHelper';

export interface AzdoRemoteEntry {
	remoteName: string;
	info: AzdoRemoteInfo;
}

export class AzdoPullRequestGitHelper {
	static readonly ID = 'AzdoPullRequestGitHelper';

	/**
	 * Checks out an Azure DevOps pull request. Same-repository pull requests fetch the
	 * source branch from the matching remote; pull requests from forks are not
	 * supported yet.
	 */
	static async fetchAndCheckout(
		repository: Repository,
		azdoRemotes: AzdoRemoteEntry[],
		pullRequest: AzdoPullRequestModel,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
	): Promise<void> {
		if (!pullRequest.validatePullRequestModel('Checkout pull request failed')) {
			return;
		}

		if (pullRequest.azdoItem.forkSource) {
			const message = vscode.l10n.t('Checking out pull requests from forks is not supported yet.');
			Logger.error(message, AzdoPullRequestGitHelper.ID);
			vscode.window.showErrorMessage(message);
			return;
		}

		const remoteInfo = pullRequest.azdoRemoteInfo;
		const remoteEntry = azdoRemotes.find(entry =>
			entry.info.orgUrl.replace(/\/$/, '').toLowerCase() === remoteInfo.orgUrl.replace(/\/$/, '').toLowerCase()
			&& entry.info.project.toLowerCase() === remoteInfo.project.toLowerCase()
			&& entry.info.repositoryName.toLowerCase() === remoteInfo.repositoryName.toLowerCase());
		if (!remoteEntry) {
			const message = vscode.l10n.t('Unable to find an Azure DevOps remote for {0}', `${remoteInfo.org}/${remoteInfo.repositoryName}`);
			Logger.error(message, AzdoPullRequestGitHelper.ID);
			vscode.window.showErrorMessage(message);
			return;
		}

		const originalBranchName = convertBranchRefToBranchName(pullRequest.azdoItem.sourceRefName || pullRequest.head.ref);
		const remoteName = remoteEntry.remoteName;
		let localBranchName = originalBranchName;

		// Always fetch the remote branch first to ensure we have the latest commits.
		const trackedBranchName = `refs/remotes/${remoteName}/${originalBranchName}`;
		Logger.appendLine(`Fetch tracked branch ${trackedBranchName}`, AzdoPullRequestGitHelper.ID);
		progress.report({ message: vscode.l10n.t('Fetching branch {0}', originalBranchName) });
		await repository.fetch(remoteName, originalBranchName);
		const trackedBranch = await repository.getBranch(trackedBranchName);

		try {
			const branch = await repository.getBranch(localBranchName);
			if (branch.commit !== trackedBranch.commit) {
				// Instead of overwriting the user's branch, create a unique branch name.
				const uniqueBranchName = await PullRequestGitHelper.calculateUniqueBranchNameForPR(repository, pullRequest);
				Logger.appendLine(`Local branch ${localBranchName} commit ${branch.commit} differs from remote commit ${trackedBranch.commit}. Creating branch ${uniqueBranchName} for pull request checkout.`, AzdoPullRequestGitHelper.ID);
				progress.report({ message: vscode.l10n.t('Creating branch {0} for pull request', uniqueBranchName) });
				await repository.createBranch(uniqueBranchName, false, trackedBranch.commit);
				await repository.setBranchUpstream(uniqueBranchName, trackedBranchName);
				localBranchName = uniqueBranchName;
			}

			if (repository.state.HEAD?.name === localBranchName) {
				Logger.appendLine(`Tried to checkout ${localBranchName}, but branch is already checked out.`, AzdoPullRequestGitHelper.ID);
			} else {
				progress.report({ message: vscode.l10n.t('Checking out {0}', localBranchName) });
				await repository.checkout(localBranchName);
				const branch = await repository.getBranch(localBranchName);
				if (!branch.upstream) {
					await repository.setBranchUpstream(localBranchName, trackedBranchName);
				}
			}
		} catch (err) {
			// There is no local branch with the same name, so create it from the remote branch.
			Logger.appendLine(`Branch ${localBranchName} doesn't exist on local disk yet. Creating from remote.`, AzdoPullRequestGitHelper.ID);
			progress.report({ message: vscode.l10n.t('Creating and checking out branch {0}', localBranchName) });
			await repository.createBranch(localBranchName, true, trackedBranch.commit);
			await repository.setBranchUpstream(localBranchName, trackedBranchName);
		}

		await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest, localBranchName);
	}
}
