/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Explicit Azure DevOps connection settings (`azdo.*`). These override what is
 * derived from the git remotes, which keeps the extension usable when the
 * remote URL cannot be parsed or the PAT should not go through the sign-in flow.
 *
 * NOTE: `azdo.pat` is stored in plaintext in settings.json. The Accounts-menu
 * sign-in (SecretStorage) is preferred for anything sensitive.
 */
export const AZDO_CONFIG_NAMESPACE = 'azdo';

function getValue(key: string): string | undefined {
	const value = vscode.workspace.getConfiguration(AZDO_CONFIG_NAMESPACE).get<string>(key);
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** Organization base URL, e.g. https://dev.azure.com/contoso. Overrides the remote-derived org. */
export function getAzdoConfigOrgUrl(): string | undefined {
	return getValue('orgUrl');
}

/** Project name. Overrides the remote-derived project. */
export function getAzdoConfigProjectName(): string | undefined {
	return getValue('projectName');
}

/** Personal access token from settings. Takes precedence over stored PATs and Entra. */
export function getAzdoConfigPat(): string | undefined {
	return getValue('pat');
}

/** Skip TLS certificate validation for on-prem servers with self-signed certificates. */
export function getAzdoConfigIgnoreCertificateErrors(): boolean {
	return vscode.workspace.getConfiguration(AZDO_CONFIG_NAMESPACE).get<boolean>('ignoreCertificateErrors') ?? false;
}
