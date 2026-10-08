/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runtime feature gates for GitHub-only surfaces (route plan S1, ADR 0002 "minimal-diff dormant").
 *
 * The GitHub surfaces stay in the tree but do not register. Each gate flips on
 * (or gets removed with its surface) in the slice that ports that surface to AzDO.
 * Keeping the code dormant rather than deleting it keeps upstream pulls
 * near-conflict-free.
 */
export const azdoGates = {
	/** Chat context providers (extension.ts), Copilot chat tools (src/lm). */
	chat: false,
	/** GitHub Issues features (src/issues, IssueFeatureRegistrar). */
	issues: false,
	/** GitHub notifications view/polling (src/notifications, NotificationsFeatureRegister). */
	notifications: false,
	/** Copilot remote coding agents (src/github/copilotRemoteAgent.ts). */
	copilotRemoteAgents: false,
	/** TreeView.message markdown banner (treeViewMarkdownMessage proposed API, compare changes tree). */
	treeViewMessage: false,
};
