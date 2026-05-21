import * as vscode from "vscode";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { toErrorMessage } from "../shared/errors";
import type { RokketWrapperWebviewProvider } from "./webview-provider";
import { UPDATE_CHECK_INTERVAL_MS } from "../shared/constants";

const GITHUB_OWNER = "Kile-Thomson";
const GITHUB_REPO = "Rokket-Wrapper";
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

const DISMISSED_VERSION_KEY = "rokketWrapper.dismissedUpdateVersion";

let cachedToken: string | null | undefined;
let cachedProvider: RokketWrapperWebviewProvider | null = null;

// ─── Token resolution ─────────────────────────────────────────────────────────

function getGitHubToken(): string | undefined {
  if (cachedToken !== undefined) return cachedToken || undefined;

  const configToken = vscode.workspace
    .getConfiguration("rokketWrapper")
    .get<string>("githubToken", "")
    ?.trim();
  if (configToken) {
    cachedToken = configToken;
    return configToken;
  }

  const envToken = (
    process.env.ROKKET_WRAPPER_GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    ""
  ).trim();
  if (envToken) {
    cachedToken = envToken;
    return envToken;
  }

  try {
    const ghToken = execSync("gh auth token", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
    if (ghToken) {
      cachedToken = ghToken;
      return ghToken;
    }
  } catch {
    // gh not installed or not authenticated
  }

  try {
    const credOutput = execSync("git credential-manager get", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      input: "protocol=https\nhost=github.com\n\n",
    }).trim();
    const passwordMatch = credOutput.match(/^password=(.+)$/m);
    if (passwordMatch?.[1]?.trim()) {
      cachedToken = passwordMatch[1].trim();
      return cachedToken;
    }
  } catch {
    // No credential manager
  }

  cachedToken = null;
  return undefined;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "RokketWrapper-VSCode",
    Accept: "application/vnd.github.v3+json",
  };
  const token = getGitHubToken();
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  return headers;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startUpdateChecker(
  context: vscode.ExtensionContext,
  provider: RokketWrapperWebviewProvider
): void {
  const currentVersion = getInstalledVersion(context);
  if (!currentVersion) return;

  cachedProvider = provider;

  const isEnabled = () =>
    vscode.workspace
      .getConfiguration("rokketWrapper")
      .get<boolean>("autoUpdate", true);

  const guardedCheck = () => {
    if (isEnabled()) checkForUpdate(context, currentVersion);
  };

  const initialTimer = setTimeout(guardedCheck, 3_000);
  context.subscriptions.push({ dispose: () => clearTimeout(initialTimer) });

  const interval = setInterval(guardedCheck, UPDATE_CHECK_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

export async function downloadAndInstallUpdate(
  url: string,
  context: vscode.ExtensionContext
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "RokketWrapper: Downloading update...",
      cancellable: false,
    },
    async () => {
      const filename = url.split("/").pop() || "rokketek-wrapper-update.vsix";
      const tmpPath = path.join(os.tmpdir(), filename);

      try {
        await downloadFile(url, tmpPath);
        await vscode.commands.executeCommand(
          "workbench.extensions.installExtension",
          vscode.Uri.file(tmpPath)
        );

        await context.globalState.update(DISMISSED_VERSION_KEY, undefined);

        const choice = await vscode.window.showInformationMessage(
          "RokketWrapper updated. Reload to activate the new version.",
          "Reload Now"
        );
        if (choice === "Reload Now") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Update failed: ${toErrorMessage(err)}`);
      } finally {
        setTimeout(() => {
          try { fs.unlinkSync(tmpPath); } catch { /* ignored */ }
        }, 5000);
      }
    }
  );
}

export async function dismissUpdateVersion(
  version: string,
  context: vscode.ExtensionContext
): Promise<void> {
  await context.globalState.update(DISMISSED_VERSION_KEY, version);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function getInstalledVersion(context: vscode.ExtensionContext): string | undefined {
  return context.extension?.packageJSON?.version
    ?? vscode.extensions.getExtension("rokketek.rokketek-wrapper")?.packageJSON?.version
    ?? vscode.extensions.getExtension("rokketek.rokket-wrapper")?.packageJSON?.version;
}

async function checkForUpdate(
  context: vscode.ExtensionContext,
  currentVersion: string
): Promise<void> {
  try {
    const release = await fetchLatestRelease();
    if (!release) return;

    const latestVersion = release.tag.replace(/^v/, "");
    if (!isNewer(latestVersion, currentVersion)) return;

    const dismissed = context.globalState.get<string>(DISMISSED_VERSION_KEY);
    if (dismissed === latestVersion) return;

    const vsixAsset = release.assets.find((a) => a.name.endsWith(".vsix"));
    if (!vsixAsset) return;

    if (cachedProvider) {
      const delivered = cachedProvider.broadcast({
        type: "update_available",
        version: latestVersion,
        currentVersion,
        releaseNotes: release.body || "",
        downloadUrl: vsixAsset.url,
        htmlUrl: release.htmlUrl,
      });

      if (!delivered) {
        showNativeUpdateNotification(
          latestVersion, currentVersion, vsixAsset.url, release.htmlUrl, context
        ).catch(() => {});
      }
    }
  } catch {
    // Silent failure — update checks are best-effort
  }
}

async function showNativeUpdateNotification(
  latestVersion: string,
  currentVersion: string,
  downloadUrl: string,
  htmlUrl: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `RokketWrapper v${latestVersion} is available (you have v${currentVersion})`,
    "Update Now",
    "Release Notes",
    "Dismiss"
  );

  if (choice === "Update Now") {
    await downloadAndInstallUpdate(downloadUrl, context);
  } else if (choice === "Release Notes") {
    vscode.env.openExternal(vscode.Uri.parse(htmlUrl));
  } else if (choice === "Dismiss") {
    await dismissUpdateVersion(latestVersion, context);
  }
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

interface ReleaseInfo {
  tag: string;
  htmlUrl: string;
  body: string;
  assets: Array<{ name: string; url: string }>;
}

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  assets?: GitHubAsset[];
}

interface GitHubAsset {
  name: string;
  url: string;
}

const TRUSTED_HOSTS = new Set([
  "github.com",
  "api.github.com",
]);

const TRUSTED_SUFFIXES = [
  ".githubusercontent.com",
  ".s3.amazonaws.com",
];

function isTrustedHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (TRUSTED_HOSTS.has(parsed.hostname)) return true;
    return TRUSTED_SUFFIXES.some(suffix => parsed.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function isGitHubHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "github.com" || parsed.hostname === "api.github.com");
  } catch {
    return false;
  }
}

const API_TIMEOUT_MS = 30_000;

function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  return new Promise((resolve) => {
    const headers = githubHeaders();

    const req = https
      .get(RELEASES_API, { headers, timeout: API_TIMEOUT_MS }, (res) => {
        if (res.statusCode === 404 || res.statusCode === 403) {
          res.resume();
          resolve(null);
          return;
        }

        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          res.resume();
          if (location) {
            if (!isTrustedHost(location)) {
              resolve(null);
              return;
            }
            const redirectHeaders = isGitHubHost(location)
              ? headers
              : { "User-Agent": "RokketWrapper-VSCode" };
            const rReq = https
              .get(location, { headers: redirectHeaders, timeout: API_TIMEOUT_MS }, (rr) => collectJson(rr, resolve));
            rReq.on("error", () => resolve(null));
            rReq.on("timeout", () => { rReq.destroy(); resolve(null); });
            return;
          }
        }

        collectJson(res, resolve);
      });

    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;

function collectJson(
  res: import("http").IncomingMessage,
  resolve: (value: ReleaseInfo | null) => void
): void {
  let data = "";
  let totalBytes = 0;
  res.on("data", (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_JSON_RESPONSE_BYTES) {
      res.destroy();
      resolve(null);
      return;
    }
    data += chunk.toString();
  });
  res.on("end", () => {
    try {
      const json: GitHubRelease = JSON.parse(data);
      resolve({
        tag: json.tag_name || "",
        htmlUrl: json.html_url || "",
        body: json.body || "",
        assets: (json.assets || []).map((a) => ({
          name: a.name,
          url: a.url,
        })),
      });
    } catch {
      resolve(null);
    }
  });
  res.on("error", () => resolve(null));
}

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let settled = false;

    const cleanup = (err?: Error) => {
      if (settled) return;
      settled = true;
      file.destroy();
      try { fs.unlinkSync(dest); } catch { /* ignored */ }
      if (err) reject(err);
    };

    file.on("error", (err) => cleanup(err));

    file.once("finish", () => {
      if (settled) return;
      settled = true;
      file.close((closeErr) => {
        if (closeErr) {
          try { fs.unlinkSync(dest); } catch { /* ignored */ }
          reject(closeErr);
          return;
        }
        resolve();
      });
    });

    const request = (downloadUrl: string, redirectCount: number = 0) => {
      if (redirectCount > MAX_REDIRECTS) {
        cleanup(new Error("Download failed: too many redirects"));
        return;
      }

      if (!isTrustedHost(downloadUrl)) {
        cleanup(new Error("Download blocked: untrusted host"));
        return;
      }

      const hdrs: Record<string, string> = {
        "User-Agent": "RokketWrapper-VSCode",
      };

      if (isGitHubHost(downloadUrl)) {
        const token = getGitHubToken();
        if (token) hdrs["Authorization"] = `token ${token}`;
        hdrs["Accept"] = "application/octet-stream";
      }

      const req = https
        .get(downloadUrl, { headers: hdrs, timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            res.resume();
            request(res.headers.location, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            cleanup(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }

          res.on("error", (err) => cleanup(err));
          res.pipe(file);
        });

      req.on("error", (err) => cleanup(err));
      req.on("timeout", () => {
        req.destroy();
        cleanup(new Error("Download timed out"));
      });
    };

    request(url);
  });
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}
