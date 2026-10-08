/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AzdoPullRequestModel } from './pullRequestModel';
import { AZDO_VOTE } from './utils';
import { ITelemetry } from '../common/telemetry';
import { formatError } from '../common/utils';
import { PRNode } from '../view/treeNodes/pullRequestNode';

/**
 * Submits a vote on the pull request of the given tree node. Shared by all AzDO vote
 * commands; no-ops for non-AzDO pull requests.
 */
async function voteOnNode(node: PRNode, vote: number, telemetryName: string, successMessage: string, telemetry: ITelemetry): Promise<void> {
	const pullRequest = node?.pullRequestModel;
	if (!(pullRequest instanceof AzdoPullRequestModel)) {
		return;
	}
	try {
		await pullRequest.submitVote(vote);
		telemetry.sendTelemetryEvent(telemetryName);
		void vscode.window.showInformationMessage(vscode.l10n.t(successMessage, String(pullRequest.number)));
		await vscode.commands.executeCommand('pr.refreshList');
	} catch (e) {
		void vscode.window.showErrorMessage(vscode.l10n.t('Voting on pull request failed: {0}', formatError(e)));
	}
}

/**
 * Registers the Azure DevOps vote commands shown in the pull request tree context menu.
 */
export function registerAzdoVoteCommands(context: vscode.ExtensionContext, telemetry: ITelemetry): void {
	context.subscriptions.push(vscode.commands.registerCommand('azdo.pr.approve', (node: PRNode) =>
		voteOnNode(node, AZDO_VOTE.APPROVED, 'azdo.vote.approve', 'Approved pull request #{0}', telemetry)));
	context.subscriptions.push(vscode.commands.registerCommand('azdo.pr.approveWithSuggestions', (node: PRNode) =>
		voteOnNode(node, AZDO_VOTE.APPROVED_WITH_SUGGESTIONS, 'azdo.vote.approveWithSuggestions', 'Approved pull request #{0} with suggestions', telemetry)));
	context.subscriptions.push(vscode.commands.registerCommand('azdo.pr.waitingForAuthor', (node: PRNode) =>
		voteOnNode(node, AZDO_VOTE.WAITING_FOR_AUTHOR, 'azdo.vote.waitingForAuthor', 'Marked pull request #{0} as waiting for author', telemetry)));
	context.subscriptions.push(vscode.commands.registerCommand('azdo.pr.reject', (node: PRNode) =>
		voteOnNode(node, AZDO_VOTE.REJECTED, 'azdo.vote.reject', 'Rejected pull request #{0}', telemetry)));
	context.subscriptions.push(vscode.commands.registerCommand('azdo.pr.resetVote', (node: PRNode) =>
		voteOnNode(node, AZDO_VOTE.NO_VOTE, 'azdo.vote.reset', 'Removed vote from pull request #{0}', telemetry)));
}
