/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pure remote-URL parsing for Azure DevOps. No vscode imports here so the logic can be
// unit tested in plain node (see src/test/scripts/azdoRemote.test.ts).

export const AZDO_CLOUD_HOST = 'dev.azure.com';
export const AZDO_CLOUD_SSH_HOST = 'ssh.dev.azure.com';
export const AZDO_LEGACY_CLOUD_HOST_SUFFIX = '.visualstudio.com';

/** The Azure DevOps resource id used when requesting Entra ID tokens. */
export const AZDO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798/.default';

export interface AzdoRemoteInfo {
	/** Remote name from git (e.g. 'origin'). */
	remoteName: string;
	/** The original remote URL, untouched. */
	url: string;
	/** Host as it appears in the URL (dev.azure.com, {org}.visualstudio.com, or an on-prem server). */
	host: string;
	/** True for dev.azure.com / ssh.dev.azure.com / {org}.visualstudio.com. */
	isCloud: boolean;
	/** Base URL for API clients: https://dev.azure.com/{org}, https://{org}.visualstudio.com, or https://{host}[/tfs]/{collection}. */
	orgUrl: string;
	/** Organization (cloud) or collection (on-prem) name. Empty when it cannot be determined. */
	org: string;
	project: string;
	repositoryName: string;
}

export function isAzdoCloudHost(host: string): boolean {
	const normalized = host.toLowerCase();
	return normalized === AZDO_CLOUD_HOST
		|| normalized === AZDO_CLOUD_SSH_HOST
		|| normalized.endsWith(AZDO_LEGACY_CLOUD_HOST_SUFFIX);
}

/**
 * Parses an Azure DevOps git remote URL.
 *
 * Recognized shapes:
 *   https://[{user}@]dev.azure.com/{org}/{project}/_git/{repo}[.git]
 *   https://[{user}@]{org}.visualstudio.com/{project}/_git/{repo}[.git]
 *   https://[{user}@]{host}[/{vdir}]/{collection}/{project}/_git/{repo}[.git]   (on-prem)
 *   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}[.git]
 *   ssh://[{user}@]ssh.dev.azure.com[:port]/v3/{org}/{project}/{repo}[.git]
 *   ssh://[{user}@]{host}[:port]/{collection}/{project}/_git/{repo}[.git]       (on-prem)
 *
 * Returns null when the URL is not an Azure DevOps remote.
 */
export function parseAzdoRemoteUrl(url: string, remoteName = 'origin'): AzdoRemoteInfo | null {
	if (!url) {
		return null;
	}

	let candidate = url.trim();

	// scp-like syntax: git@host:path
	const scpMatch = /^([^@/]+@)?([^:/]+):(.+)$/.exec(candidate);
	if (scpMatch && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
		candidate = `ssh://${scpMatch[1] ?? ''}${scpMatch[2]}/${scpMatch[3]}`;
	}

	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch (e) {
		return null;
	}

	const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
	if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ssh' && scheme !== 'git') {
		return null;
	}

	const host = parsed.hostname.toLowerCase();
	const effectiveScheme = scheme === 'ssh' || scheme === 'git' ? 'https' : scheme;
	const pathSegments = decodeURIComponent(parsed.pathname)
		.replace(/\\/g, '/')
		.split('/')
		.filter(segment => segment.length > 0)
		.map(segment => segment.replace(/\.git$/, ''));

	// Cloud SSH: ssh.dev.azure.com/v3/{org}/{project}/{repo}
	if (host === AZDO_CLOUD_SSH_HOST) {
		if (pathSegments[0] === 'v3' && pathSegments.length >= 4) {
			const org = pathSegments[1];
			const project = pathSegments[2];
			const repoSegments = pathSegments.slice(3);
			return {
				remoteName,
				url,
				host,
				isCloud: true,
				orgUrl: `https://${AZDO_CLOUD_HOST}/${org}`,
				org,
				project,
				repositoryName: repoSegments.join('/'),
			};
		}
		return null;
	}

	if (host === AZDO_CLOUD_HOST) {
		// https://dev.azure.com/{org}/{project}/_git/{repo}
		const gitIndex = pathSegments.indexOf('_git');
		if (gitIndex === 2 && pathSegments.length === 4) {
			return {
				remoteName,
				url,
				host,
				isCloud: true,
				orgUrl: `https://${AZDO_CLOUD_HOST}/${pathSegments[0]}`,
				org: pathSegments[0],
				project: pathSegments[1],
				repositoryName: pathSegments[3],
			};
		}
		return null;
	}

	if (host.endsWith(AZDO_LEGACY_CLOUD_HOST_SUFFIX)) {
		// https://{org}.visualstudio.com/[{collection}/]{project}/_git/{repo}
		const org = host.slice(0, -AZDO_LEGACY_CLOUD_HOST_SUFFIX.length);
		const gitIndex = pathSegments.indexOf('_git');
		if (gitIndex >= 1 && gitIndex === pathSegments.length - 2) {
			return {
				remoteName,
				url,
				host,
				isCloud: true,
				orgUrl: `https://${host}`,
				org,
				project: pathSegments[gitIndex - 1],
				repositoryName: pathSegments[gitIndex + 1],
			};
		}
		return null;
	}

	// On-premises: any host whose path contains '_git'.
	const gitIndex = pathSegments.indexOf('_git');
	if (gitIndex >= 1 && gitIndex === pathSegments.length - 2) {
		const project = pathSegments[gitIndex - 1];
		const prefix = pathSegments.slice(0, gitIndex - 1); // e.g. ['tfs', 'DefaultCollection'] or ['DefaultCollection']
		const org = prefix.length > 0 ? prefix[prefix.length - 1] : '';
		const orgUrl = `${effectiveScheme}://${host}${prefix.length > 0 ? '/' + prefix.join('/') : ''}`;
		return {
			remoteName,
			url,
			host,
			isCloud: false,
			orgUrl,
			org,
			project,
			repositoryName: pathSegments[gitIndex + 1],
		};
	}

	return null;
}

/**
 * Stable, filesystem-and-secret-storage-safe key for an org URL.
 * Uses base64url so it works in both node and webworker extension hosts.
 */
export function azdoSecretKey(orgUrl: string): string {
	const normalized = orgUrl.toLowerCase().replace(/\/$/, '');
	return `azdo.pat.${btoa(normalized).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/**
 * Parses a configured organization URL (e.g. https://dev.azure.com/contoso or
 * https://tfs.contoso.com/tfs/DefaultCollection) into its host/org parts.
 * Returns null when the value is not a usable http(s) URL.
 */
export function parseAzdoOrgUrl(orgUrl: string): { orgUrl: string; host: string; isCloud: boolean; org: string } | null {
	if (!orgUrl) {
		return null;
	}
	let candidate = orgUrl.trim().replace(/\/+$/, '');
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
		candidate = `https://${candidate}`;
	}
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch (e) {
		return null;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		return null;
	}
	const host = parsed.hostname.toLowerCase();
	const segments = parsed.pathname.replace(/\\/g, '/').split('/').filter(segment => segment.length > 0);
	let org = '';
	if (host === AZDO_CLOUD_HOST) {
		org = segments[0] ?? '';
	} else if (host.endsWith(AZDO_LEGACY_CLOUD_HOST_SUFFIX)) {
		org = host.slice(0, -AZDO_LEGACY_CLOUD_HOST_SUFFIX.length);
	} else {
		org = segments[segments.length - 1] ?? '';
	}
	return { orgUrl: candidate, host, isCloud: isAzdoCloudHost(host), org };
}

/**
 * Applies the explicit `azdo.orgUrl` / `azdo.projectName` settings to a parsed remote.
 *
 * - With no configured orgUrl the parsed info is returned unchanged (null stays null).
 * - With a configured orgUrl the org (and project, when configured) are overridden, which
 *   also makes unparseable remote URLs usable as long as a project is configured: the
 *   repository name is taken to be the last meaningful segment of the remote URL.
 */
export function applyAzdoConfigOverrides(
	info: AzdoRemoteInfo | null,
	url: string,
	remoteName: string,
	config: { orgUrl?: string; project?: string },
): AzdoRemoteInfo | null {
	if (!config.orgUrl) {
		return info;
	}
	const parsedOrg = parseAzdoOrgUrl(config.orgUrl);
	if (!parsedOrg) {
		return info;
	}
	if (info) {
		return { ...info, orgUrl: parsedOrg.orgUrl, project: config.project ?? info.project };
	}
	if (!config.project) {
		return null;
	}
	// Synthesize from the raw remote URL: repository name = last non-marker path segment.
	let candidate = url.trim();
	const scpMatch = /^([^@/]+@)?([^:/]+):(.+)$/.exec(candidate);
	if (scpMatch && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
		candidate = `ssh://${scpMatch[1] ?? ''}${scpMatch[2]}/${scpMatch[3]}`;
	}
	const segments = candidate
		.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
		.replace(/\\/g, '/')
		.split('/')
		.map(segment => segment.replace(/\.git$/, '').trim())
		.filter(segment => segment.length > 0 && segment !== '_git' && segment !== 'v3');
	const repositoryName = segments[segments.length - 1];
	if (!repositoryName) {
		return null;
	}
	return {
		remoteName,
		url,
		host: parsedOrg.host,
		isCloud: parsedOrg.isCloud,
		orgUrl: parsedOrg.orgUrl,
		org: parsedOrg.org,
		project: config.project,
		repositoryName,
	};
}
