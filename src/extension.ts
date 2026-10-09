import * as vscode from 'vscode';

import { TokioViewProvider, VIEW_ID } from './ui/panel';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TokioViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('tokio.focusView', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tokio');
    })
  );
}

export function deactivate(): void {
  // No resources need explicit disposal; subscriptions are owned by VS Code.
}
