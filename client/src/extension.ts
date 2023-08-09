/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import {
	workspace as Workspace, window as Window, ExtensionContext, TextDocument, OutputChannel, WorkspaceFolder, Uri
} from 'vscode';
import { 
	LanguageClient, LanguageClientOptions, TransportKind, ExecutableOptions, ServerOptions
} from 'vscode-languageclient/node';
import { downloadThriftLanguageServer } from "./download"
import { spawn } from 'child_process';


import { ErrorAction, CloseAction, ErrorHandler, Message } from 'vscode-languageclient/node'; // 请替换成实际的模块路径

let defaultClient: LanguageClient;
const clients: Map<string, LanguageClient> = new Map();

let _sortedWorkspaceFolders: string[] | undefined;
function sortedWorkspaceFolders(): string[] {
	if (_sortedWorkspaceFolders === void 0) {
		_sortedWorkspaceFolders = Workspace.workspaceFolders ? Workspace.workspaceFolders.map(folder => {
			let result = folder.uri.toString();
			if (result.charAt(result.length - 1) !== '/') {
				result = result + '/';
			}
			return result;
		}).sort(
			(a, b) => {
				return a.length - b.length;
			}
		) : [];
	}
	return _sortedWorkspaceFolders;
}
Workspace.onDidChangeWorkspaceFolders(() => _sortedWorkspaceFolders = undefined);

function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
	const sorted = sortedWorkspaceFolders();
	for (const element of sorted) {
		let uri = folder.uri.toString();
		if (uri.charAt(uri.length - 1) !== '/') {
			uri = uri + '/';
		}
		if (uri.startsWith(element)) {
			return Workspace.getWorkspaceFolder(Uri.parse(element))!;
		}
	}
	return folder;
}


class MyErrorHandler implements ErrorHandler {
    error(error: Error, message: Message | undefined, count: number | undefined): ErrorAction {
        // 在这里处理错误，可以根据需要返回适当的 ErrorAction
        // 例如，可以记录错误、重试等
        console.log("err: ", error, "message: ", message, "count: ", count)
        return ErrorAction.Continue; // 假设 ErrorAction 是一个枚举，这里返回一个示例值
    }

    closed(): CloseAction {
        // 在这里处理连接关闭事件，可以返回适当的 CloseAction
        // 例如，可以重新连接、停止等
        console.log("close")
        return CloseAction.DoNotRestart; // 假设 CloseAction 是一个枚举，这里返回一个示例值
    }
}

export async function activate(context: ExtensionContext) {
    console.log('Congratulations, your extension "helloworld-sample" is now active!');

    const binaryPath = await downloadThriftLanguageServer(context)

    console.log("setup server options")

	function didOpenTextDocument(document: TextDocument): void {
        console.log("didOpenTextDocument", document)
		// We are only interested in language mode text
		if (document.languageId !== 'thrift' || document.uri.scheme === 'untitled' || (document.uri.scheme !== 'file' )) {
			return;
		}

		const uri = document.uri;
		let folder = Workspace.getWorkspaceFolder(uri);
		// Files outside a folder can't be handled. This might depend on the language.
		// Single file languages like JSON might handle files outside the workspace folders.
		if (!folder) {
			return;
		}
		// If we have nested workspace folders we only start a server on the outer most workspace folder.
		folder = getOuterMostWorkspaceFolder(folder);

		if (!clients.has(folder.uri.toString())) {
            const exeOptions: ExecutableOptions = {
                cwd: folder ? undefined : path.dirname(uri.fsPath),
            };
            let args: string[] = [];

			const serverOptions: ServerOptions = {
				run: { command: binaryPath, transport: TransportKind.stdio, args, options: exeOptions },
				debug: { command: binaryPath, transport: TransportKind.stdio, args, options: exeOptions }
			};

            // let serverOptions = (): Thenable<any> => {
            //     // Start the server using child_process.spawn(...);
            //     // Hook the childProcess.stderr.on('data', data => ...));
            //     let childProcess = spawn(binaryPath, args)
            //     childProcess.stderr.on('data', (data) => {
            //         console.error(`stderr: ${data}`);
            //       });
                  
            //     childProcess.on('close', (code) => {
            //         console.log(`child process exited with code ${code}`);
            //       }); 
                
            //     return childProcess; // Uses stdin/stdout for communication
            // }

            const langName = "thriftls" 
            const outputChannel: OutputChannel = Window.createOutputChannel(langName);
			const clientOptions: LanguageClientOptions = {
				documentSelector: [
					{ scheme: 'file', language: 'thrift', pattern: `${folder.uri.fsPath}/**/*` }
				],
				diagnosticCollectionName: 'thrift-language-server',
				workspaceFolder: folder,
				outputChannel: outputChannel,
                errorHandler: new MyErrorHandler,
			};
			const client = new LanguageClient('thrift-language-server', 'Thrift LSP Multi Server', serverOptions, clientOptions, true);
			client.start();
			clients.set(folder.uri.toString(), client);
            console.log("client start")
		}
	}

	Workspace.onDidOpenTextDocument(didOpenTextDocument);
	Workspace.textDocuments.forEach(didOpenTextDocument);
	Workspace.onDidChangeWorkspaceFolders((event) => {
		for (const folder  of event.removed) {
			const client = clients.get(folder.uri.toString());
			if (client) {
				clients.delete(folder.uri.toString());
				client.stop();
			}
		}
	});
}

export function deactivate(): Thenable<void> {
	const promises: Thenable<void>[] = [];
	if (defaultClient) {
		promises.push(defaultClient.stop());
	}
	for (const client of clients.values()) {
		promises.push(client.stop());
	}
	return Promise.all(promises).then(() => undefined);
}
