/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { applyAzdoConfigOverrides, azdoSecretKey, isAzdoCloudHost, parseAzdoOrgUrl, parseAzdoRemoteUrl } from '../../azdo/remote';

describe('azdo remote parsing', () => {
	describe('cloud https', () => {
		it('parses the canonical form with a user prefix', () => {
			const info = parseAzdoRemoteUrl('https://contoso@dev.azure.com/contoso/Fabrikam/_git/FiberWeb', 'origin');
			assert.ok(info);
			assert.strictEqual(info.host, 'dev.azure.com');
			assert.ok(info.isCloud);
			assert.strictEqual(info.orgUrl, 'https://dev.azure.com/contoso');
			assert.strictEqual(info.org, 'contoso');
			assert.strictEqual(info.project, 'Fabrikam');
			assert.strictEqual(info.repositoryName, 'FiberWeb');
			assert.strictEqual(info.remoteName, 'origin');
		});

		it('parses without a user prefix and strips .git', () => {
			const info = parseAzdoRemoteUrl('https://dev.azure.com/contoso/Fabrikam/_git/FiberWeb.git');
			assert.ok(info);
			assert.strictEqual(info.org, 'contoso');
			assert.strictEqual(info.project, 'Fabrikam');
			assert.strictEqual(info.repositoryName, 'FiberWeb');
		});

		it('is case-insensitive on host and decodes segments', () => {
			const info = parseAzdoRemoteUrl('https://contoso@DEV.AZURE.COM/contoso/My%20Project/_git/Repo');
			assert.ok(info);
			assert.strictEqual(info.host, 'dev.azure.com');
			assert.strictEqual(info.project, 'My Project');
		});
	});

	describe('legacy visualstudio.com', () => {
		it('parses org from the host', () => {
			const info = parseAzdoRemoteUrl('https://contoso.visualstudio.com/Fabrikam/_git/FiberWeb');
			assert.ok(info);
			assert.ok(info.isCloud);
			assert.strictEqual(info.org, 'contoso');
			assert.strictEqual(info.orgUrl, 'https://contoso.visualstudio.com');
			assert.strictEqual(info.project, 'Fabrikam');
			assert.strictEqual(info.repositoryName, 'FiberWeb');
		});
	});

	describe('ssh', () => {
		it('parses the scp-like v3 form', () => {
			const info = parseAzdoRemoteUrl('git@ssh.dev.azure.com:v3/contoso/Fabrikam/FiberWeb');
			assert.ok(info);
			assert.ok(info.isCloud);
			assert.strictEqual(info.host, 'ssh.dev.azure.com');
			assert.strictEqual(info.orgUrl, 'https://dev.azure.com/contoso');
			assert.strictEqual(info.project, 'Fabrikam');
			assert.strictEqual(info.repositoryName, 'FiberWeb');
		});

		it('parses the ssh:// v3 form', () => {
			const info = parseAzdoRemoteUrl('ssh://git@ssh.dev.azure.com/v3/contoso/Fabrikam/FiberWeb');
			assert.ok(info);
			assert.strictEqual(info.org, 'contoso');
		});

		it('parses an on-prem ssh url with a port', () => {
			const info = parseAzdoRemoteUrl('ssh://user@tfs.contoso.com:22/tfs/DefaultCollection/Fabrikam/_git/FiberWeb');
			assert.ok(info);
			assert.ok(!info.isCloud);
			assert.strictEqual(info.org, 'DefaultCollection');
			assert.strictEqual(info.orgUrl, 'https://tfs.contoso.com/tfs/DefaultCollection');
			assert.strictEqual(info.project, 'Fabrikam');
		});
	});

	describe('on-prem https', () => {
		it('parses the tfs virtual directory', () => {
			const info = parseAzdoRemoteUrl('https://tfs.contoso.com/tfs/DefaultCollection/Fabrikam/_git/FiberWeb');
			assert.ok(info);
			assert.ok(!info.isCloud);
			assert.strictEqual(info.host, 'tfs.contoso.com');
			assert.strictEqual(info.org, 'DefaultCollection');
			assert.strictEqual(info.orgUrl, 'https://tfs.contoso.com/tfs/DefaultCollection');
			assert.strictEqual(info.project, 'Fabrikam');
			assert.strictEqual(info.repositoryName, 'FiberWeb');
		});

		it('parses without a virtual directory', () => {
			const info = parseAzdoRemoteUrl('https://tfs.contoso.com/DefaultCollection/Fabrikam/_git/FiberWeb');
			assert.ok(info);
			assert.strictEqual(info.orgUrl, 'https://tfs.contoso.com/DefaultCollection');
			assert.strictEqual(info.org, 'DefaultCollection');
		});
	});

	describe('non-AzDO urls', () => {
		it('rejects GitHub urls', () => {
			assert.strictEqual(parseAzdoRemoteUrl('https://github.com/microsoft/vscode.git'), null);
			assert.strictEqual(parseAzdoRemoteUrl('git@github.com:microsoft/vscode.git'), null);
		});

		it('rejects urls without _git or v3 markers', () => {
			assert.strictEqual(parseAzdoRemoteUrl('https://dev.azure.com/contoso'), null);
			assert.strictEqual(parseAzdoRemoteUrl('https://example.com/Fabrikam/_git'), null);
			assert.strictEqual(parseAzdoRemoteUrl(''), null);
		});
	});

	describe('isAzdoCloudHost', () => {
		it('recognizes cloud hosts only', () => {
			assert.ok(isAzdoCloudHost('dev.azure.com'));
			assert.ok(isAzdoCloudHost('ssh.dev.azure.com'));
			assert.ok(isAzdoCloudHost('contoso.visualstudio.com'));
			assert.ok(!isAzdoCloudHost('tfs.contoso.com'));
			assert.ok(!isAzdoCloudHost('github.com'));
		});
	});

	describe('azdoSecretKey', () => {
		it('is stable, trimmed and url-safe', () => {
			const a = azdoSecretKey('https://dev.azure.com/contoso');
			const b = azdoSecretKey('https://DEV.AZURE.COM/contoso/');
			assert.strictEqual(a, b);
			assert.ok(!/[+/=]/.test(a));
			assert.ok(a.startsWith('azdo.pat.'));
		});
	});

	describe('parseAzdoOrgUrl', () => {
		it('parses cloud, legacy and on-prem org urls', () => {
			assert.deepStrictEqual(parseAzdoOrgUrl('https://dev.azure.com/contoso'), { orgUrl: 'https://dev.azure.com/contoso', host: 'dev.azure.com', isCloud: true, org: 'contoso' });
			assert.strictEqual(parseAzdoOrgUrl('contoso.visualstudio.com')?.org, 'contoso');
			assert.strictEqual(parseAzdoOrgUrl('https://tfs.contoso.com/tfs/DefaultCollection')?.org, 'DefaultCollection');
			assert.strictEqual(parseAzdoOrgUrl('https://tfs.contoso.com/tfs/DefaultCollection')?.isCloud, false);
			assert.strictEqual(parseAzdoOrgUrl('not a url'), null);
		});
	});

	describe('applyAzdoConfigOverrides', () => {
		it('returns the parsed info unchanged when no org url is configured', () => {
			const info = parseAzdoRemoteUrl('https://dev.azure.com/contoso/Proj/_git/repo', 'origin');
			assert.strictEqual(applyAzdoConfigOverrides(info, 'https://dev.azure.com/contoso/Proj/_git/repo', 'origin', {}), info);
			assert.strictEqual(applyAzdoConfigOverrides(null, 'https://github.com/x/y', 'origin', {}), null);
		});
		it('overrides org url and project on parsed remotes', () => {
			const info = parseAzdoRemoteUrl('https://dev.azure.com/contoso/Proj/_git/repo', 'origin')!;
			const overridden = applyAzdoConfigOverrides(info, 'https://dev.azure.com/contoso/Proj/_git/repo', 'origin', { orgUrl: 'https://dev.azure.com/other', project: 'RealProj' })!;
			assert.strictEqual(overridden.orgUrl, 'https://dev.azure.com/other');
			assert.strictEqual(overridden.project, 'RealProj');
			assert.strictEqual(overridden.repositoryName, 'repo');
		});
		it('synthesizes info for unparseable remotes when project is configured', () => {
			const synthesized = applyAzdoConfigOverrides(null, 'https://tfs.corp.local/git/MyRepo.git', 'upstream', { orgUrl: 'https://tfs.corp.local/tfs/Col', project: 'Proj' })!;
			assert.strictEqual(synthesized.orgUrl, 'https://tfs.corp.local/tfs/Col');
			assert.strictEqual(synthesized.project, 'Proj');
			assert.strictEqual(synthesized.repositoryName, 'MyRepo');
			assert.strictEqual(synthesized.org, 'Col');
			assert.strictEqual(synthesized.remoteName, 'upstream');
		});
		it('cannot synthesize without a configured project', () => {
			assert.strictEqual(applyAzdoConfigOverrides(null, 'https://tfs.corp.local/git/MyRepo', 'upstream', { orgUrl: 'https://tfs.corp.local/tfs/Col' }), null);
		});
	});
});
