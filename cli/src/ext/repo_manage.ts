import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { exec } from "child_process";
import yaml from "yaml";
import { extract_yaml_from_ecl_content, parse_eclair_template_from_any } from "./template_utils";
import type { EclairPresetTemplateSource, EclairRepos } from "./config";
import type { EclairTemplate } from "./template";
import { match } from "ts-pattern";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: T } | { err: E };

// ---------------------------------------------------------------------------
// Cache directory
// ---------------------------------------------------------------------------

/**
 * Root directory for caching git repo checkouts.
 * Uses XDG_CACHE_HOME if set, otherwise ~/.cache.
 * Structure: `<cacheDir>/zephyr-workbench-eclair/repos/checkouts/`
 */
function get_repo_checkouts_root(): string {
  const base = process.env["XDG_CACHE_HOME"] || path.join(os.homedir(), ".cache");
  return path.join(base, "zephyr-workbench-eclair", "repos", "checkouts");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves the absolute path for a preset source and loads the template from
 * it. Does NOT perform any git checkout — the repo must already be checked out
 * (see `ensure_repo_checkout`).
 */
export async function load_preset_no_checkout(
  source: EclairPresetTemplateSource,
  repos: EclairRepos,
  repo_revs: Record<string, string>,
): Promise<Result<[EclairTemplate, string], string>> {
  let abs_path: string;
  try {
    abs_path = match(source)
      .with({ type: "system-path" }, ({ path: p }) => p)
      .with({ type: "repo-path" }, ({ repo, path: rel_path }) => {
        const entry = repos[repo];
        if (!entry) {
          throw new Error(`Repository '${repo}' not found in repos configuration.`);
        }
        const rev = repo_revs[repo];
        if (!rev) {
          throw new Error(
            `Revision for repository '${repo}' is not known, cannot load preset '${rel_path}'. ` +
            `Known revs: ${JSON.stringify(repo_revs)}`,
          );
        }
        return path.join(get_checkout_dir(entry.origin, entry.ref, rev), rel_path);
      })
      .exhaustive();
  } catch (err: any) {
    return { err: `Failed to resolve preset path: ${err?.message || err}` };
  }

  return load_preset_from_path(abs_path);
}

/**
 * Ensures the given repo is checked out at the given revision and returns
 * `[checkoutDir, resolvedRev]`.
 */
export async function ensure_repo_checkout(
  name: string,
  origin: string,
  ref: string,
  rev?: string,
): Promise<[string, string]> {
  const resolved_rev = rev ?? await resolve_ref_to_rev(origin, ref);
  if (!resolved_rev) {
    throw new Error(`Failed to resolve ref '${ref}' for repo '${name}'.`);
  }
  const checkoutDir = get_checkout_dir(origin, ref, resolved_rev);
  await checkout_repo_into_dir(checkoutDir, origin, ref, resolved_rev);
  return [checkoutDir, resolved_rev];
}

/**
 * Resolves a branch/tag name to a full commit SHA using `git ls-remote`.
 * If `ref` already looks like a SHA it is returned as-is.
 */
export async function resolve_ref_to_rev(origin: string, ref: string): Promise<string | undefined> {
  const trimmed = ref.trim();
  if (!trimmed) {
    return undefined;
  }
  if (looks_like_sha(trimmed)) {
    return trimmed;
  }
  const refsResult = await ls_remote(origin);
  if ("err" in refsResult) {
    return undefined;
  }
  const refs = refsResult.ok;
  return (
    refs[`refs/tags/${trimmed}^{}`] ||
    refs[`refs/heads/${trimmed}`] ||
    refs[`refs/tags/${trimmed}`] ||
    refs[trimmed]
  );
}

export async function deleteRepoCheckout(origin: string, ref: string, rev: string): Promise<void> {
  const checkoutDir = get_checkout_dir(origin, ref, rev);
  if (fs.existsSync(checkoutDir)) {
    await fs.promises.rm(checkoutDir, { recursive: true, force: true });
  }
}

export async function getRepoHeadRevision(dir: string): Promise<string | undefined> {
  return read_head_rev(dir);
}

// ---------------------------------------------------------------------------
// Preset loading
// ---------------------------------------------------------------------------

async function load_preset_from_path(
  preset_path: string,
): Promise<Result<[EclairTemplate, string], string>> {
  preset_path = preset_path.trim();
  if (!preset_path) {
    return { err: "Invalid preset path." };
  }

  let content: string;
  try {
    content = await fs.promises.readFile(preset_path, { encoding: "utf8" });
  } catch (err: any) {
    return { err: `Failed to read preset: ${err?.message || err}` };
  }

  const yaml_content = extract_yaml_from_ecl_content(content);
  if (yaml_content === undefined) {
    return { err: "The selected file does not contain valid ECL template content." };
  }

  let data: unknown;
  try {
    data = yaml.parse(yaml_content);
  } catch (err: any) {
    return { err: `Failed to parse preset YAML: ${err?.message || err}` };
  }

  let template: EclairTemplate;
  try {
    template = parse_eclair_template_from_any(data);
  } catch (err: any) {
    return { err: `Invalid preset content: ${err?.message || err}` };
  }

  return { ok: [template, preset_path] };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function get_checkout_dir(origin: string, _ref: string, rev: string): string {
  const hash = origin_hash(origin);
  const safe_rev = sanitize_path_component(rev);
  return path.join(get_repo_checkouts_root(), hash, safe_rev);
}

function origin_hash(origin: string): string {
  return crypto.createHash("sha256").update(origin).digest("hex").slice(0, 12);
}

function sanitize_path_component(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_");
}

function looks_like_sha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

async function read_remote_origin(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    exec("git remote get-url origin", { cwd: dir }, (_err, stdout) => {
      resolve(stdout.trim() || undefined);
    });
  });
}

async function read_head_rev(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    exec("git rev-parse HEAD", { cwd: dir }, (_err, stdout) => {
      resolve(stdout.trim() || undefined);
    });
  });
}

async function is_checkout_usable(dir: string, origin: string, expected_rev?: string): Promise<boolean> {
  const isGitDir = fs.existsSync(path.join(dir, ".git")) || fs.existsSync(path.join(dir, "HEAD"));
  if (!isGitDir) {
    return false;
  }
  const storedOrigin = await read_remote_origin(dir);
  if (storedOrigin !== origin) {
    return false;
  }
  if (expected_rev) {
    const head = await read_head_rev(dir);
    return !!head && head.startsWith(expected_rev);
  }
  return true;
}

async function checkout_repo_into_dir(
  checkoutDir: string,
  origin: string,
  ref: string,
  rev?: string,
): Promise<void> {
  if (await is_checkout_usable(checkoutDir, origin, rev)) {
    return;
  }

  if (fs.existsSync(checkoutDir)) {
    await fs.promises.rm(checkoutDir, { recursive: true, force: true });
  }
  await fs.promises.mkdir(checkoutDir, { recursive: true });

  const run = (cmd: string, cwd: string) =>
    new Promise<void>((resolve, reject) => {
      exec(cmd, { cwd }, (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`Command failed (${cmd}): ${stderr || err.message}`));
        } else {
          resolve();
        }
      });
    });

  await run("git init", checkoutDir);
  await run(`git remote add origin ${JSON.stringify(origin)}`, checkoutDir);

  try {
    await run(`git fetch --depth=1 origin ${JSON.stringify(ref)}`, checkoutDir);
    if (rev) {
      await run(`git checkout ${JSON.stringify(rev)}`, checkoutDir);
    } else {
      await run("git checkout FETCH_HEAD", checkoutDir);
    }
  } catch {
    // Fallback: full clone
    await fs.promises.rm(checkoutDir, { recursive: true, force: true });
    await fs.promises.mkdir(checkoutDir, { recursive: true });
    if (rev) {
      await run(`git clone ${JSON.stringify(origin)} ${JSON.stringify(checkoutDir)}`, os.homedir());
      await run(`git checkout ${JSON.stringify(rev)}`, checkoutDir);
    } else {
      await run(
        `git clone --depth=1 --branch ${JSON.stringify(ref)} ${JSON.stringify(origin)} ${JSON.stringify(checkoutDir)}`,
        os.homedir(),
      );
    }
  }
}

async function ls_remote(url: string): Promise<Result<Record<string, string>, string>> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      exec(`git ls-remote ${JSON.stringify(url)}`, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Failed to list remote refs: ${stderr || err.message}`));
        } else {
          resolve(stdout);
        }
      });
    });

    const refs: Record<string, string> = {};
    for (const line of stdout.split(/\r?\n/)) {
      const [hash, ref] = line.split(/\s+/);
      if (hash && ref) {
        refs[ref] = hash;
      }
    }
    return { ok: refs };
  } catch (err) {
    return { err: (err as Error).message };
  }
}
