import * as vscode from "vscode";
import { RokketWrapperWebviewProvider } from "./webview-provider";
import { startUpdateChecker } from "./update-checker";
import { runTelegramSetup, updateTelegramStatusBar } from "./telegram/setup";
import { getOpenAiApiKey, setOpenAiApiKey } from "./openai/config";

// ============================================================
// Extension Entry Point
// ============================================================

let provider: RokketWrapperWebviewProvider;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("RokketWrapper");
  const output = outputChannel;
  output.appendLine("RokketWrapper extension activating...");

  provider = new RokketWrapperWebviewProvider(context.extensionUri, context);

  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = "rokketWrapper.open";
  statusBarItem.text = "$(rocket) RokketWrapper";
  statusBarItem.tooltip = "Open RokketWrapper";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Wire up status updates from the provider
  provider.onStatusUpdate((status) => {
    if (status.isStreaming) {
      statusBarItem.text = "$(loading~spin) RokketWrapper";
      statusBarItem.tooltip = `RokketWrapper: Working...${status.cost ? ` ($${status.cost.toFixed(3)})` : ""}`;
    } else if (status.model) {
      const costStr = status.cost ? ` • $${status.cost.toFixed(3)}` : "";
      statusBarItem.text = "$(rocket) RokketWrapper";
      statusBarItem.tooltip = `RokketWrapper: ${status.model}${costStr}`;
    } else {
      statusBarItem.text = "$(rocket) RokketWrapper";
      statusBarItem.tooltip = "Open RokketWrapper";
    }
  });

  // Register sidebar webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      RokketWrapperWebviewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("rokketWrapper.open", () => {
      const preferred = vscode.workspace
        .getConfiguration("rokketWrapper")
        .get<string>("preferredLocation", "panel");
      if (preferred === "sidebar") {
        vscode.commands.executeCommand("rokketWrapper.openInSidebar");
      } else {
        vscode.commands.executeCommand("rokketWrapper.openInTab");
      }
    }),

    vscode.commands.registerCommand("rokketWrapper.openInTab", () => {
      provider.openInTab();
    }),

    vscode.commands.registerCommand("rokketWrapper.openInSidebar", () => {
      vscode.commands.executeCommand("rokketWrapper-sidebar.focus");
    }),

    vscode.commands.registerCommand("rokketWrapper.focus", () => {
      provider.focus();
    }),

    vscode.commands.registerCommand("rokketWrapper.telegramSetup", () => runTelegramSetup(context)),

    vscode.commands.registerCommand("rokketWrapper.setOpenAiApiKey", async () => {
      const existing = await getOpenAiApiKey(context.secrets);
      const proceed = await vscode.window.showInformationMessage(
        existing ? "Replace OpenAI API Key" : "Set Up Voice Transcription",
        {
          modal: true,
          detail: existing
            ? "You already have an OpenAI API key stored. Enter a new key to replace it."
            : "Voice transcription lets you send voice messages from Telegram " +
              "and have them automatically transcribed using OpenAI Whisper.\n\n" +
              "You need an OpenAI API key with some credit on it:\n" +
              "1. Go to platform.openai.com and sign up (or log in)\n" +
              "2. Go to API keys and create a new key\n" +
              "3. Add credit to your account (even $5 will last a very long time)\n" +
              "4. Copy the key — you'll paste it in the next step\n\n" +
              "Cost: Whisper transcription costs approximately $0.006 per minute " +
              "of audio — a 1-minute voice message costs less than a cent.\n\n" +
              "The key is stored securely in your OS keychain and never leaves your machine.",
        },
        "Continue",
      );
      if (proceed !== "Continue") return;

      const key = await vscode.window.showInputBox({
        title: "Paste your OpenAI API key",
        prompt: "This key is stored securely in your OS keychain and never leaves your machine",
        placeHolder: "sk-...",
        password: true,
        ignoreFocusOut: true,
      });
      if (!key || !key.trim()) return;
      await setOpenAiApiKey(context.secrets, key.trim());
      vscode.window.showInformationMessage("OpenAI API key saved — voice transcription is ready!");
    })
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("rokketWrapper")) {
        output.appendLine("RokketWrapper configuration changed");
        provider.onConfigChanged();
        if (e.affectsConfiguration("rokketWrapper.telegram")) {
          updateTelegramStatusBar(statusBarItem, context);
        }
      }
    })
  );

  // Check Telegram config and update status bar
  updateTelegramStatusBar(statusBarItem, context);

  // Check for updates from GitHub Releases
  startUpdateChecker(context, provider);

  output.appendLine("RokketWrapper extension activated");
}

export async function deactivate(): Promise<void> {
  if (provider) {
    await provider.disposeAsync();
  }
  statusBarItem?.dispose();
  outputChannel?.dispose();
}
