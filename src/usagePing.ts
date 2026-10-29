import { randomUUID } from "crypto";
import * as vscode from "vscode";

const INSTALL_ID_KEY = "codecook.installId";
const PING_DAY_KEY = "codecook.usagePingDay";
const PING_URL = "https://us-central1-makayis-codebaker-19a4d.cloudfunctions.net/usagePing";

export function pingUsage(context: vscode.ExtensionContext): void {
  void sendPing(context);
}

async function sendPing(context: vscode.ExtensionContext): Promise<void> {
  try {
    if (context.extensionMode === vscode.ExtensionMode.Test) {
      return;
    }
    if (!vscode.env.isTelemetryEnabled) {
      return;
    }
    if (vscode.workspace.getConfiguration("codecook").get<boolean>("usagePing", true) === false) {
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    if (context.globalState.get<string>(PING_DAY_KEY) === day) {
      return;
    }
    const installId = await ensureInstallId(context);
    const version = String(context.extension.packageJSON.version ?? "");
    const appName = vscode.env.appName.slice(0, 64);
    const response = await fetch(PING_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installId, version, appName }),
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) {
      await context.globalState.update(PING_DAY_KEY, day);
    }
  } catch {
    // Activation continues when the ping cannot be sent.
  }
}

async function ensureInstallId(context: vscode.ExtensionContext): Promise<string> {
  const existing = context.globalState.get<string>(INSTALL_ID_KEY);
  if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
    return existing;
  }
  const installId = randomUUID();
  await context.globalState.update(INSTALL_ID_KEY, installId);
  return installId;
}
