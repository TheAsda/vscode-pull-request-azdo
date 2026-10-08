/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as azdev from 'azure-devops-node-api';
import { IRequestHandler } from 'azure-devops-node-api/interfaces/common/VsoBaseInterfaces';
import { Identity } from 'azure-devops-node-api/interfaces/IdentitiesInterfaces';
import { getAzdoConfigIgnoreCertificateErrors } from './config';
import Logger from '../common/logger';

export interface AzdoValidatedConnection {
	connection: AzdoConnection;
	user: Identity;
}

/**
 * A validated connection to one Azure DevOps organization/collection.
 */
export class AzdoConnection {
	public readonly api: azdev.WebApi;

	constructor(
		public readonly orgUrl: string,
		private readonly handler: IRequestHandler,
		private readonly isPat: boolean,
	) {
		// `azdo.ignoreCertificateErrors`: for on-prem servers with self-signed certificates.
		const ignoreSslError = getAzdoConfigIgnoreCertificateErrors();
		this.api = new azdev.WebApi(orgUrl, handler, ignoreSslError ? { ignoreSslError: true } : undefined);
	}

	/**
	 * Validates credentials by round-tripping the connection API. Throws on auth failure.
	 */
	public async validate(): Promise<Identity> {
		const data = await this.api.connect();
		if (!data || !data.authenticatedUser) {
			throw new Error(noAuthenticatedUserMessage(this.orgUrl));
		}
		return data.authenticatedUser;
	}
}

export function createPatConnection(orgUrl: string, token: string): AzdoConnection {
	return new AzdoConnection(orgUrl, azdev.getPersonalAccessTokenHandler(token, true), true);
}

export function createBearerConnection(orgUrl: string, token: string): AzdoConnection {
	return new AzdoConnection(orgUrl, azdev.getBearerHandler(token, true), false);
}

/**
 * Distinguishes "bad credentials" (PAT/Entra token rejected) from other failures so the
 * credential store can decide whether to fall through to another auth mode.
 */
export function isAuthFailure(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const message = error.message.toLowerCase();
	if (message.includes('401') || message.includes('203') || message.includes('unauthorized') || message.includes('access denied')) {
		Logger.appendLine(`AzDO auth failure: ${error.message}`, 'AzdoCredentials');
		return true;
	}
	return false;
}

export function noAuthenticatedUserMessage(orgUrl: string): string {
	return `Authentication to ${orgUrl} did not return an authenticated user.`;
}
