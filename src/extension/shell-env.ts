import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EXEC_TIMEOUT_MS } from "../shared/constants";

// Static well-known bin directories for macOS/Linux.
const KNOWN_BIN_DIRS_UNIX: string[] = [
  "/usr/local/bin",                                       // homebrew (Intel Mac), npm global default
  "/opt/homebrew/bin",                                    // homebrew (Apple Silicon)
  "/opt/homebrew/sbin",
  "/snap/bin",                                            // snap packages (Linux)
  path.join(os.homedir(), ".npm-global", "bin"),          // npm global with custom prefix
  path.join(os.homedir(), ".volta", "bin"),               // volta
  path.join(os.homedir(), ".local", "bin"),               // misc (pipx, fnm, etc.)
  path.join(os.homedir(), ".yarn", "bin"),                // yarn global
  "/usr/local/lib/node_modules/.bin",                     // older npm global layout
];

// Static well-known bin directories for Windows.
const KNOWN_BIN_DIRS_WIN: string[] = [
  path.join(os.homedir(), "AppData", "Roaming", "npm"),  // npm global (Windows default)
  path.join(os.homedir(), ".volta", "bin"),              // volta
  path.join(os.homedir(), "AppData", "Roaming", "nvm"),  // nvm-windows
];

/**
 * Try to resolve the active nvm node version bin dir.
 * Reads ~/.nvm/alias/default to find the pinned version.
 */
function getNvmBinDir(): string | null {
  try {
    const aliasPath = path.join(os.homedir(), ".nvm", "alias", "default");
    const alias = fs.readFileSync(aliasPath, "utf8").trim();
    // alias may be "v20.11.0" or "20" (short form)
    const nvmVersionsDir = path.join(os.homedir(), ".nvm", "versions", "node");
    const versions = fs.readdirSync(nvmVersionsDir).sort().reverse();
    // Find exact match first, then prefix match
    const match = versions.find(v => v === alias || v === `v${alias}` || v.startsWith(`v${alias.replace(/^v/, "")}.`));
    if (match) return path.join(nvmVersionsDir, match, "bin");
  } catch { /* nvm not installed or alias not set */ }
  return null;
}

/**
 * Try to resolve the active fnm node version bin dir.
 * Reads ~/.local/share/fnm/aliases/default symlink.
 */
function getFnmBinDir(): string | null {
  try {
    const fnmBase = path.join(os.homedir(), ".local", "share", "fnm");
    const aliasDefault = path.join(fnmBase, "aliases", "default");
    const target = fs.readlinkSync(aliasDefault);
    const resolved = path.resolve(path.dirname(aliasDefault), target);
    const bin = path.join(resolved, "bin");
    if (fs.statSync(bin).isDirectory()) return bin;
  } catch { /* fnm not installed */ }
  return null;
}

/**
 * Returns well-known bin directories that exist on this machine but may not
 * be in the inherited VS Code PATH. Handles macOS, Linux, and Windows.
 * On macOS/Linux also probes nvm/fnm active version paths.
 */
export function getKnownBinDirs(): string[] {
  const staticDirs = process.platform === "win32" ? KNOWN_BIN_DIRS_WIN : KNOWN_BIN_DIRS_UNIX;
  const dynamic: Array<string | null> = process.platform !== "win32"
    ? [getNvmBinDir(), getFnmBinDir()]
    : [];

  return [...staticDirs, ...dynamic.filter((d): d is string => d !== null)]
    .filter(d => {
      try { return fs.statSync(d).isDirectory(); } catch { return false; }
    });
}

let cachedEnv: Record<string, string> | null = null;
let resolving: Promise<Record<string, string>> | null = null;

/**
 * On Linux/macOS, VS Code launched from the desktop doesn't inherit the
 * user's shell environment (~/.bashrc, ~/.zshrc, ~/.profile). This means
 * PATH (where node/gsd live), API keys, and other env vars are missing.
 *
 * This resolves the user's login shell environment once and caches it.
 * On Windows this is a no-op — env vars propagate correctly there.
 */
export function resolveShellEnv(): Promise<Record<string, string>> {
  if (cachedEnv) return Promise.resolve(cachedEnv);
  if (resolving) return resolving;

  if (process.platform === "win32") {
    cachedEnv = {};
    return Promise.resolve(cachedEnv);
  }

  resolving = doResolve().then(env => {
    cachedEnv = env;
    resolving = null;
    return env;
  }).catch(() => {
    resolving = null;
    return {} as Record<string, string>;
  });

  return resolving;
}

/**
 * Merge shell env into a base env object. Shell env provides missing
 * PATH segments and env vars, but doesn't overwrite explicitly set values.
 * Pass `extraDirs` (e.g. from getKnownBinDirs()) to inject additional PATH
 * entries as a last-resort fallback when shell resolution misses them.
 */
export function mergeShellEnv(
  base: Record<string, string>,
  shell: Record<string, string>,
  extraDirs: string[] = [],
): Record<string, string> {
  const merged = { ...base };

  const pathSep = process.platform === "win32" ? ";" : ":";
  for (const [key, value] of Object.entries(shell)) {
    if (key === "PATH" || key === "Path") {
      // Append shell PATH segments that aren't already present
      const basePath = merged.PATH || merged.Path || "";
      const baseParts = new Set(basePath.split(pathSep).filter(Boolean));
      const shellParts = value.split(pathSep).filter(Boolean);
      const newParts = shellParts.filter(p => !baseParts.has(p));
      if (newParts.length > 0) {
        const pathKey = "PATH" in merged ? "PATH" : "Path" in merged ? "Path" : "PATH";
        merged[pathKey] = basePath ? `${basePath}${pathSep}${newParts.join(pathSep)}` : newParts.join(pathSep);
      }
    } else if (!(key in base)) {
      // Only add keys that weren't in the original base env.
      // Using `base` (not `merged`) prevents shell env from reintroducing
      // vars that were intentionally removed during sanitization.
      merged[key] = value;
    }
  }

  // Inject known-good dirs that still aren't in PATH (fallback for dock-launched VS Code)
  if (extraDirs.length > 0) {
    const pathKey = "PATH" in merged ? "PATH" : "Path" in merged ? "Path" : "PATH";
    const currentPath = merged[pathKey] || "";
    const currentParts = new Set(currentPath.split(pathSep).filter(Boolean));
    const missing = extraDirs.filter(d => !currentParts.has(d));
    if (missing.length > 0) {
      merged[pathKey] = currentPath ? `${currentPath}${pathSep}${missing.join(pathSep)}` : missing.join(pathSep);
    }
  }

  return merged;
}

function doResolve(): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const shell = process.env.SHELL || "/bin/sh";

    // Run a login+interactive shell that prints env as null-delimited pairs.
    // The markers ensure we only parse the env block, not shell startup noise.
    const marker = `__GSD_ENV_${Date.now()}__`;
    const script = `echo '${marker}' && env -0 && echo '${marker}'`;

    execFile(shell, ["-ilc", script], {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      env: { ...process.env },
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        // Fallback: try non-interactive login shell
        execFile(shell, ["-lc", script], {
          encoding: "utf8",
          timeout: EXEC_TIMEOUT_MS,
          env: { ...process.env },
          maxBuffer: 1024 * 1024,
        }, (err2, stdout2) => {
          if (err2) return reject(err2);
          resolve(parseEnv(stdout2, marker));
        });
        return;
      }
      resolve(parseEnv(stdout, marker));
    });
  });
}

function parseEnv(stdout: string, marker: string): Record<string, string> {
  const env: Record<string, string> = {};

  // Extract content between markers
  const startIdx = stdout.indexOf(marker);
  const endIdx = stdout.lastIndexOf(marker);
  if (startIdx === -1 || endIdx === -1 || startIdx === endIdx) {
    // No markers — try parsing the whole output
    return parseEnvRaw(stdout);
  }

  const block = stdout.slice(startIdx + marker.length, endIdx).trim();
  // env -0 uses null bytes as delimiters
  const entries = block.split("\0").filter(Boolean);
  for (const entry of entries) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx > 0) {
      env[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    }
  }

  return env;
}

function parseEnvRaw(stdout: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of stdout.split(/\n/)) {
    const eqIdx = line.indexOf("=");
    if (eqIdx > 0) {
      const key = line.slice(0, eqIdx);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        env[key] = line.slice(eqIdx + 1);
      }
    }
  }
  return env;
}
