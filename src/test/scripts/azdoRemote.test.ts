/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { azdoSecretKey, isAzdoCloudHost, parseAzdoRemoteUrl } from '../../azdo/remote';

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
});
