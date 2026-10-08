/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AzdoConnection, createBearerConnection, createPatConnection, isAuthFailure } from './azdoApi';
import { AZDO_RESOURCE_ID, azdoSecretKey, isAzdoCloudHost } from './remote';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';

export const AZDO_AUTH_PROVIDER_ID = 'azdo';
export const AZDO_AUTH_PROVIDER_LABEL = 'Azure DevOps';
export const AZDO_SCOPES_PAT = ['pat'];
/** Scopes used against the built-in 'microsoft' provider; Entra auth is cloud-only. */
export const AZDO_ENTRA_SCOPES = [AZDO_RESOURCE_ID, 'offline_access'];

interface StoredPat {
	orgUrl: string;
	token: string;
	accountId: string;
	accountLabel: string;
}

/**
 * VS Code authentication provider backed by SecretStorage. PATs live ONLY in the secret
 * store, never in settings. Session scopes are `[orgUrl]`; session ids are the secret keys.
 * SecretStorage cannot enumerate keys, so stored PATs are recovered lazily, one known
 * org URL at a time.
 */
class AzdoAuthenticationProvider implements vscode.AuthenticationProvider {
	private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	public readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly _sessions = new Map<string, vscode.AuthenticationSession>();

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly telemetry: ITelemetry,
	) { }

	public async getSessions(scopes: readonly string[] | undefined, _options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession[]> {
		if (scopes && scopes.length > 0) {
			const orgUrl = normalizeOrgUrl(scopes[0]);
			const session = await this.loadSessionForOrg(orgUrl);
			return session ? [session] : [];
		}
		return [...this._sessions.values()];
	}

	/** Synchronous check for sessions recovered or created in this window. */
	public hasInMemorySession(orgUrl: string): boolean {
		return this._sessions.has(azdoSecretKey(normalizeOrgUrl(orgUrl)));
	}

	public async removeSessionsForOrg(orgUrl: string): Promise<void> {
		const session = await this.loadSessionForOrg(normalizeOrgUrl(orgUrl));
		if (session) {
			await this.removeSession(session.id);
		}
	}

	public async createSession(scopes: readonly string[], _options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
		let orgUrl = scopes.length > 0 ? normalizeOrgUrl(scopes[0]) : undefined;
		if (!orgUrl) {
			orgUrl = await this.promptForOrgUrl();
			if (!orgUrl) {
				throw new Error(vscode.l10n.t('Sign in to Azure DevOps was canceled.'));
			}
		}

		const token = await this.promptForPat(orgUrl);
		if (!token) {
			throw new Error(vscode.l10n.t('Sign in to Azure DevOps was canceled.'));
		}

		const connection = createPatConnection(orgUrl, token);
		const user = await connection.validate();

		const session: vscode.AuthenticationSession = {
			id: azdoSecretKey(orgUrl),
			accessToken: token,
			scopes: [orgUrl],
			account: {
				id: user.id ?? sessionAccountId(orgUrl),
				label: accountLabel(user, orgUrl),
			},
		};

		await this.storePat(session, token);
		this._sessions.set(session.id, session);
		this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
		return session;
	}

	public async removeSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return;
		}
		this._sessions.delete(sessionId);
		await this.secrets.delete(sessionId);
		this._onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });
	}

	private async storePat(session: vscode.AuthenticationSession, token: string): Promise<void> {
		const stored: StoredPat = {
			orgUrl: session.scopes[0],
			token,
			accountId: session.account.id,
			accountLabel: session.account.label,
		};
		await this.secrets.store(session.id, JSON.stringify(stored));
	}

	private async loadSessionForOrg(orgUrl: string): Promise<vscode.AuthenticationSession | undefined> {
		const key = azdoSecretKey(orgUrl);
		if (this._sessions.has(key)) {
			return this._sessions.get(key);
		}
		const stored = await this.secrets.get(key);
		if (!stored) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(stored) as StoredPat;
			const session: vscode.AuthenticationSession = {
				id: key,
				accessToken: parsed.token,
				scopes: [normalizeOrgUrl(parsed.orgUrl)],
				account: { id: parsed.accountId, label: parsed.accountLabel },
			};
			this._sessions.set(key, session);
			return session;
		} catch (error) {
			Logger.appendLine(`Failed to restore AzDO PAT for ${orgUrl}: ${error instanceof Error ? error.message : String(error)}`, 'AzdoCredentials');
			await this.secrets.delete(key);
			return undefined;
		}
	}

	private async promptForOrgUrl(): Promise<string | undefined> {
		const orgUrl = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Organization URL, e.g. https://dev.azure.com/contoso'),
			placeHolder: 'https://dev.azure.com/organization',
			ignoreFocusOut: true,
			validateInput: value => value.startsWith('https://') ? undefined : vscode.l10n.t('The URL must start with https://'),
		});
		return orgUrl ? normalizeOrgUrl(orgUrl) : undefined;
	}

	private async promptForPat(orgUrl: string): Promise<string | undefined> {
		return vscode.window.showInputBox({
			password: true,
			prompt: vscode.l10n.t('Personal access token for {0}. Create one at {1} under User settings > Personal access tokens.', orgUrl, `${orgUrl}/_usersSettings/tokens`),
			placeHolder: vscode.l10n.t('Personal access token'),
			ignoreFocusOut: true,
		});
	}
}

function normalizeOrgUrl(orgUrl: string): string {
	return orgUrl.trim().replace(/\/+$/, '').toLowerCase();
}

function sessionAccountId(orgUrl: string): string {
	return orgUrl;
}

function accountLabel(user: { providerDisplayName?: string; customDisplayName?: string; displayName?: string }, fallback: string): string {
	return user.customDisplayName || user.providerDisplayName || user.displayName || fallback;
}

/**
 * Owns AzDO connections. PATs are preferred; Entra ID (built-in 'microsoft' provider,
 * cloud orgs only) is the fallback.
 */
export class AzdoCredentialStore implements vscode.Disposable {
	private readonly _provider: AzdoAuthenticationProvider;
	private readonly _connections = new Map<string, AzdoConnection>();
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _onDidChangeCredentials = new vscode.EventEmitter<string>();
	/** Fires with the orgUrl whose credentials changed (added or removed). */
	public readonly onDidChangeCredentials = this._onDidChangeCredentials.event;

	constructor(private readonly telemetry: ITelemetry, context: vscode.ExtensionContext) {
		this._provider = new AzdoAuthenticationProvider(context.secrets, telemetry);
		this._disposables.push(
			vscode.authentication.registerAuthenticationProvider(AZDO_AUTH_PROVIDER_ID, AZDO_AUTH_PROVIDER_LABEL, this._provider, {
				supportsMultipleAccounts: true,
			}),
		);
		this._disposables.push(
			this._provider.onDidChangeSessions(change => {
				for (const removed of change.removed ?? []) {
					this._connections.delete(removed.scopes[0]);
					this._onDidChangeCredentials.fire(removed.scopes[0]);
				}
				for (const added of change.added ?? []) {
					this._onDidChangeCredentials.fire(added.scopes[0]);
				}
			}),
		);
		// Entra sessions are owned by the 'microsoft' provider and can be refreshed or
		// removed at any time; drop affected connections so the next call re-reads them.
		this._disposables.push(
			vscode.authentication.onDidChangeSessions(e => {
				if (e.provider.id === 'microsoft') {
					for (const orgUrl of [...this._connections.keys()]) {
						if (!this.hasStoredPat(orgUrl)) {
							this._connections.delete(orgUrl);
						}
					}
				}
			}),
		);
	}

	/** All PAT sessions known to the provider (used by tests and future account UI). */
	public async getPatSessions(): Promise<vscode.AuthenticationSession[]> {
		return this._provider.getSessions(undefined, {});
	}

	public hasStoredPat(orgUrl: string): boolean {
		return this._provider.hasInMemorySession(orgUrl);
	}

	public isAuthenticated(orgUrl: string): boolean {
		return this._connections.has(normalizeOrgUrl(orgUrl));
	}

	public getConnection(orgUrl: string): AzdoConnection | undefined {
		return this._connections.get(normalizeOrgUrl(orgUrl));
	}

	/**
	 * Returns a validated connection for the org, creating one when needed.
	 * PAT (if stored) > Entra (cloud orgs) > PAT prompt (when createIfNone).
	 */
	public async getOrCreateConnection(orgUrl: string, options: { createIfNone?: boolean } = {}): Promise<AzdoConnection | undefined> {
		const normalized = normalizeOrgUrl(orgUrl);
		const cached = this._connections.get(normalized);
		if (cached) {
			return cached;
		}

		/* __GDPR__
			"azdo.auth.start" : {}
		*/
		this.telemetry.sendTelemetryEvent('azdo.auth.start');

		const connection = await this.doCreateConnection(normalized, options);
		if (connection) {
			this._connections.set(normalized, connection);
			/* __GDPR__
				"azdo.auth.success" : {}
			*/
			this.telemetry.sendTelemetryEvent('azdo.auth.success');
			this._onDidChangeCredentials.fire(normalized);
		} else {
			/* __GDPR__
				"azdo.auth.failed" : {}
			*/
			this.telemetry.sendTelemetryErrorEvent('azdo.auth.failed');
		}
		return connection;
	}

	public async signOut(orgUrl: string): Promise<void> {
		const normalized = normalizeOrgUrl(orgUrl);
		this._connections.delete(normalized);
		await this._provider.removeSessionsForOrg(normalized);
		this._onDidChangeCredentials.fire(normalized);
	}

	private async doCreateConnection(normalized: string, options: { createIfNone?: boolean }): Promise<AzdoConnection | undefined> {
		// 1. Stored PAT.
		const patSession = await this._provider.getSessions([normalized], {});
		if (patSession.length > 0) {
			const connection = createPatConnection(normalized, patSession[0].accessToken);
			try {
				await connection.validate();
				return connection;
			} catch (error) {
				if (!isAuthFailure(error)) {
					Logger.appendLine(`AzDO connection error for ${normalized}: ${error instanceof Error ? error.message : String(error)}`, 'AzdoCredentials');
					return undefined;
				}
				// Bad PAT: drop it and fall through.
				await this._provider.removeSessionsForOrg(normalized);
			}
		}

		// 2. Entra ID via the built-in 'microsoft' provider (cloud orgs only).
		if (isAzdoCloudOrgUrl(normalized)) {
			const sessionOptions: vscode.AuthenticationGetSessionOptions = {};
			if (options.createIfNone) {
				sessionOptions.createIfNone = true;
			}
			const session = await vscode.authentication.getSession('microsoft', AZDO_ENTRA_SCOPES, sessionOptions);
			if (session) {
				const connection = createBearerConnection(normalized, session.accessToken);
				try {
					await connection.validate();
					return connection;
				} catch (error) {
					if (!isAuthFailure(error)) {
						Logger.appendLine(`AzDO connection error for ${normalized}: ${error instanceof Error ? error.message : String(error)}`, 'AzdoCredentials');
						return undefined;
					}
					if (options.createIfNone) {
						const forced = await vscode.authentication.getSession('microsoft', AZDO_ENTRA_SCOPES, { forceNewSession: true });
						if (forced) {
							const retry = createBearerConnection(normalized, forced.accessToken);
							await retry.validate();
							return retry;
						}
					}
				}
			}
		}

		// 3. Prompt for a PAT.
		if (options.createIfNone) {
			try {
				const session = await this._provider.createSession([normalized], {});
				const connection = createPatConnection(normalized, session.accessToken);
				await connection.validate();
				return connection;
			} catch (error) {
				Logger.appendLine(`AzDO PAT sign-in failed for ${normalized}: ${error instanceof Error ? error.message : String(error)}`, 'AzdoCredentials');
				return undefined;
			}
		}

		return undefined;
	}

	dispose(): void {
		this._disposables.forEach(disposable => disposable.dispose());
		this._onDidChangeCredentials.dispose();
	}
}

function isAzdoCloudOrgUrl(orgUrl: string): boolean {
	try {
		return isAzdoCloudHost(new URL(orgUrl).hostname);
	} catch {
		return false;
	}
}
