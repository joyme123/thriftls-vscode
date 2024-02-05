import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as url from 'url';
import * as process from 'process'
import { promisify } from 'util';
import { env, ExtensionContext, ProgressLocation, Uri, window, workspace, WorkspaceFolder } from 'vscode';
import { downloadFile, executableExists, httpsGetSilently } from './utils';
import * as validate from './validation';

/** GitHub API release */
interface IRelease {
    assets: IAsset[];
    tag_name: string;
    prerelease: boolean;
    last_check_time?: number;
}
/** GitHub API asset */
interface IAsset {
    browser_download_url: string;
    name: string;
}

type UpdateBehaviour = 'keep-up-to-date' | 'prompt' | 'never-check' | 'weekly';

const assetValidator: validate.Validator<IAsset> = validate.object({
    browser_download_url: validate.string(),
    name: validate.string(),
});

const releaseValidator: validate.Validator<IRelease> = validate.object({
    assets: validate.array(assetValidator),
    tag_name: validate.string(),
    prerelease: validate.boolean(),
    last_check_time: validate.optional(validate.number())
});

const githubReleaseApiValidator: validate.Validator<IRelease[]> = validate.array(releaseValidator);

const cachedReleaseValidator: validate.Validator<IRelease | null> = validate.optional(releaseValidator);

// On Windows the executable needs to be stored somewhere with an .exe extension
const exeExt = process.platform === 'win32' ? '.exe' : '';

// tslint:disable-next-line: max-classes-per-file
class NoBinariesError extends Error {
    constructor(version: string) {
        super(`thriftls ${version} is not available on ${os.type()}.`);
    }
}

async function getLatestReleaseMetadata(context: ExtensionContext): Promise<IRelease | null> {
    const releasesUrl = workspace.getConfiguration('thriftls').releasesURL
        ? url.parse(workspace.getConfiguration('thriftls').releasesURL)
        : undefined;
    const opts: https.RequestOptions = releasesUrl
        ? {
            host: releasesUrl.host,
            path: releasesUrl.path,
        }
        : {
            host: 'api.github.com',
            path: '/repos/joyme123/thrift-ls/releases',
        };

    const offlineCache = path.join(context.globalStorageUri.fsPath, 'latestApprovedRelease.cache.json');

    async function readCachedReleaseData(): Promise<IRelease | null> {
        try {
            const cachedInfo = await promisify(fs.readFile)(offlineCache, { encoding: 'utf-8' });
            return validate.parseAndValidate(cachedInfo, cachedReleaseValidator);
        } catch (err) {
            // If file doesn't exist, return null, otherwise consider it a failure
            if (err.code === 'ENOENT') {
                return null;
            }
            throw err;
        }
    }
    // Not all users want to upgrade right away, in that case prompt
    const updateBehaviour = workspace.getConfiguration('thriftls').get('updateBehavior') as UpdateBehaviour;

    if (updateBehaviour === 'never-check') {
        console.log("skip check lastest release by api")
        return readCachedReleaseData();
    } else if (updateBehaviour === 'weekly') {
        let cached = await readCachedReleaseData();
        let days = (Date.now() - cached.last_check_time) / (24 * 3600 * 1000)
        console.log("diff days: ", days)
        if (days < 7) {
            console.log("skip check lastest release because days is ", days)
            return readCachedReleaseData();
        }
    }


    try {
        const releaseInfo = await httpsGetSilently(opts);
        const latestInfoParsed =
            validate.parseAndValidate(releaseInfo, githubReleaseApiValidator).find((x) => !x.prerelease) || null;

        if (updateBehaviour === 'prompt') {
            const cachedInfoParsed = await readCachedReleaseData();

            if (
                latestInfoParsed !== null &&
                (cachedInfoParsed === null || latestInfoParsed.tag_name !== cachedInfoParsed.tag_name)
            ) {
                const promptMessage =
                    cachedInfoParsed === null
                        ? 'No version of the thriftls is installed, would you like to install it now?'
                        : 'A new version of the thriftls is available, would you like to upgrade now?';

                const decision = await window.showInformationMessage(promptMessage, 'Download', 'Nevermind');
                if (decision !== 'Download') {
                    // If not upgrade, bail and don't overwrite cached version information
                    return cachedInfoParsed;
                }
            }
        }

        // set last check time
        latestInfoParsed.last_check_time = Date.now()

        // Cache the latest successfully fetched release information
        await promisify(fs.writeFile)(offlineCache, JSON.stringify(latestInfoParsed), { encoding: 'utf-8' });
        return latestInfoParsed;
    } catch (githubError) {
        // Attempt to read from the latest cached file
        try {
            const cachedInfoParsed = await readCachedReleaseData();

            window.showWarningMessage(
                `Couldn't get the latest thriftls releases from GitHub, used local cache instead:\n${githubError.message}`
            );
            return cachedInfoParsed;
        } catch (fileError) {
            throw new Error(`Couldn't get the latest thriftls releases from GitHub:\n${githubError.message}`);
        }
    }
}
/**
 * Downloads the latest haskell-language-server binaries from GitHub releases.
 * Returns null if it can't find any that match.
 */
export async function downloadThriftLanguageServer(
    context: ExtensionContext,
): Promise<string | null> {
    // Make sure to create this before getProjectGhcVersion
    if (!fs.existsSync(context.globalStorageUri.fsPath)) {
        fs.mkdirSync(context.globalStorageUri.fsPath);
    }

    const githubOS = getGithubOS();
    if (githubOS === null) {
        // Don't have any binaries available for this platform
        window.showErrorMessage(`Couldn't find any pre-built thriftls binaries for ${process.platform}`);
        return null;
    }
    const arch = getArch()

    // Fetch the latest release from GitHub or from cache
    const release = await getLatestReleaseMetadata(context);
    if (!release) {
        let message = "Couldn't find any pre-built thriftls binaries because of network error";
        const updateBehaviour = workspace.getConfiguration('thriftls').get('updateBehavior') as UpdateBehaviour;
        if (updateBehaviour === 'never-check') {
            message += ' (and checking for newer versions is disabled)';
        } else {
            message += ` you can download thriftls from https://github.com/joyme123/thrift-ls/releases and place it at ${context.globalStorageUri.fsPath}`
        }

        window.showErrorMessage(message);
        return null;
    }

    console.log("get release ok");

    // When searching for binaries, use startsWith because the compression may differ
    // between .zip and .gz
    const assetName = `thriftls-${githubOS}-${arch}${exeExt}`;
    const asset = release?.assets.find((x) => x.name.startsWith(assetName));
    if (!asset) {
        window.showInformationMessage(new NoBinariesError(release.tag_name).message);
        return null;
    }

    const serverName = asset.name;
    const binaryDest = path.join(context.globalStorageUri.fsPath, serverName);

    const title = `Downloading thriftls ${release.tag_name}`;
    await downloadFile(title, asset.browser_download_url, context.globalStorageUri.fsPath, binaryDest, release.tag_name);
    return binaryDest;
}

function getArch(): string {
    // Possible values are: `'arm'`, `'arm64'`, `'ia32'`, `'mips'`,`'mipsel'`, `'ppc'`,`'ppc64'`, `'s390'`, `'s390x'`, and `'x64'`.
    switch (process.arch) {
        case "arm64":
            return "arm64"
        case "x64":
            return "amd64"
        case "ia32":
            return "386"
    }
}

/** Get the OS label used by GitHub for the current platform */
function getGithubOS(): string | null {
    function platformToGithubOS(x: string): string | null {
        switch (x) {
            case 'darwin':
                return 'darwin';
            case 'linux':
                return 'linux';
            case 'win32':
                return 'windows';
            default:
                return null;
        }
    }

    return platformToGithubOS(process.platform);
}