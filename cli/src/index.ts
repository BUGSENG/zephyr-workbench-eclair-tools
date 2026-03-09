#!/usr/bin/env node

import path from "path";
import fs from "fs";
import os from "os";
import { execSync, spawn } from "child_process";
import { Command } from "commander";
import { FullEclairScaConfigSchema, EclairScaConfig, EclairRepos, ALL_ECLAIR_REPORTS } from "./ext/config";
import { ensure_repo_checkout, load_preset_no_checkout, resolve_ref_to_rev } from "./ext/repo_manage";
import { format_option_settings } from "./ext/template_utils";

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("zephyr-workbench-eclair")
  .description("CLI utils for the ECLAIR Manager panel configurations")
  .version("0.1.0");

interface AnalyzeOptions {
  board: string;
  config?: string;
  buildDir?: string;
  scaDirOutput?: string;
  dryRun: boolean;
  verbose: boolean;
}

program
  .command("analyze")
  .description(
    "Run an ECLAIR analysis on a Zephyr project folder.\n" +
    "The folder must contain .vscode/zephyr-workbench.eclair.json.",
  )
  .argument("<project-dir>", "Path to the Zephyr application directory")
  .requiredOption("-b, --board <board>", "Target board (e.g. native_sim, nrf52840dk/nrf52840)")
  .option("-c, --config <name>", "SCA config name to use (defaults to current_config_index)")
  .option("-d, --build-dir <dir>", "Override the west build output directory")
  .option("--sca-dir-output <file>", "Write the path to the SCA output directory (build/sca/eclair) to this file")
  .option("--dry-run", "Print the west command without executing it", false)
  .option("--verbose", "Enable verbose output", false)
  .action(async (projectDir: string, options: AnalyzeOptions) => {
    try {
      await runAnalyze(path.resolve(projectDir), options);
    } catch (err: any) {
      console.error(`Error: ${err?.message || err}`);
      process.exit(1);
    }
  });

program.parse(process.argv);

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

async function runAnalyze(appDir: string, options: AnalyzeOptions): Promise<void> {
  const log = options.verbose ? console.log.bind(console) : () => {};

  // 1. Load zephyr-workbench.eclair.json
  const settingsPath = path.join(appDir, ".vscode", "zephyr-workbench.eclair.json");
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Settings file not found: ${settingsPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const cfg = FullEclairScaConfigSchema.parse(raw);
  log(`Loaded config from ${settingsPath}`);

  // 2. Pick the right EclairScaConfig
  let scaConfig: EclairScaConfig;
  if (options.config) {
    const found = cfg.configs.find((c) => c.name === options.config);
    if (!found) {
      const names = cfg.configs.map((c) => `"${c.name}"`).join(", ");
      throw new Error(`Config "${options.config}" not found. Available: ${names}`);
    }
    scaConfig = found;
  } else {
    const idx = cfg.current_config_index ?? 0;
    const found = cfg.configs[idx];
    if (!found) {
      throw new Error(`No config at index ${idx}`);
    }
    scaConfig = found;
  }
  log(`Using SCA config: "${scaConfig.name}"`);

  // 3. Build the CMake args
  const repos = cfg.repos ?? {};
  const cmakeArgs: string[] = ["-DZEPHYR_SCA_VARIANT=eclair"];

  // Unset ccache compiler launchers (they break ECLAIR's wrapper)
  if (process.platform === "win32") {
    cmakeArgs.push("-DCMAKE_C_COMPILER_LAUNCHER=", "-DCMAKE_CXX_COMPILER_LAUNCHER=");
  } else {
    cmakeArgs.push("-UCMAKE_C_COMPILER_LAUNCHER", "-UCMAKE_CXX_COMPILER_LAUNCHER");
  }

  const mainCfg = scaConfig.main_config;

  if (mainCfg.type === "zephyr-ruleset") {
    // Simple named ruleset
    if (mainCfg.ruleset === "USER") {
      cmakeArgs.push("-DECLAIR_RULESET_USER=ON");
      if (mainCfg.userRulesetName) cmakeArgs.push(`-DECLAIR_USER_RULESET_NAME="${mainCfg.userRulesetName}"`);
      if (mainCfg.userRulesetPath) cmakeArgs.push(`-DECLAIR_USER_RULESET_PATH="${mainCfg.userRulesetPath}"`);
      cmakeArgs.push("-DECLAIR_RULESET_FIRST_ANALYSIS=OFF");
    } else if (mainCfg.ruleset) {
      cmakeArgs.push(`-D${mainCfg.ruleset}=ON`, "-DECLAIR_RULESET_FIRST_ANALYSIS=OFF");
    } else {
      cmakeArgs.push("-DECLAIR_RULESET_FIRST_ANALYSIS=ON");
    }
  } else if (mainCfg.type === "custom-ecl") {
    // Custom .ecl file: create a user ruleset that eval_file's it
    const eclPath = mainCfg.ecl_path.replace(/\\/g, "/");
    const { user_ruleset_name, user_ruleset_path } = create_user_ruleset(
      [`-eval_file="${eclPath}"`],
    );
    cmakeArgs.push(
      "-DECLAIR_RULESET_USER=ON",
      `-DECLAIR_USER_RULESET_NAME="${user_ruleset_name}"`,
      `-DECLAIR_USER_RULESET_PATH="${user_ruleset_path}"`,
      "-DECLAIR_RULESET_FIRST_ANALYSIS=OFF",
    );
  } else {
    // Preset: checkout repos, load templates, generate ECL options
    const repo_revs = await resolve_all_repo_revs(repos, log);

    // Ensure all referenced repos are checked out
    for (const [name, entry] of Object.entries(repos)) {
      log(`Ensuring repo '${name}' is checked out...`);
      await ensure_repo_checkout(name, entry.origin, entry.ref, repo_revs[name]);
    }

    const allSelections = [
      ...mainCfg.rulesets,
      ...mainCfg.variants,
      ...mainCfg.tailorings,
    ];

    const eclairOptions: string[] = [
      `-project_name="${path.basename(appDir)} (${scaConfig.name})"`,
      `-project_root="${appDir}"`,
    ];

    for (const sel of allSelections) {
      const result = await load_preset_no_checkout(sel.source, repos, repo_revs);
      if ("err" in result) {
        throw new Error(`Failed to load preset: ${result.err}`);
      }
      const [template, absPath] = result.ok;
      const statements = format_option_settings(template, sel.edited_flags ?? {}).map((s) => s.statement);
      eclairOptions.push(...statements);
      eclairOptions.push(`-eval_file="${absPath.replace(/\\/g, "/")}"`);
    }

    const { user_ruleset_name, user_ruleset_path } = create_user_ruleset(eclairOptions);
    cmakeArgs.push(
      "-DECLAIR_RULESET_USER=ON",
      `-DECLAIR_USER_RULESET_NAME="${user_ruleset_name}"`,
      `-DECLAIR_USER_RULESET_PATH="${user_ruleset_path}"`,
      "-DECLAIR_RULESET_FIRST_ANALYSIS=OFF",
    );
  }

  // 4. Options file (ECLAIR_ENV_ADDITIONAL_OPTIONS wrapper)
  const wrapperPath = write_options_wrapper([], scaConfig.extra_config);
  cmakeArgs.push(`-DECLAIR_OPTIONS_FILE=${wrapperPath.replace(/\\/g, "/")}`);

  // 5. Reports
  const reports = scaConfig.reports ?? [];
  const selectedReports = reports.includes("ALL")
    ? ALL_ECLAIR_REPORTS
    : reports.filter((r) => r !== "ALL");
  for (const r of selectedReports) {
    cmakeArgs.push(`-D${r}=ON`);
  }

  // 6. Determine build dir and derived SCA output dir
  const buildDir = options.buildDir ?? path.join(appDir, "build", "primary");
  const scaDir = path.join(buildDir, "sca", "eclair");

  // 7. Assemble west command
  const westArgs = [
    "build",
    "--pristine",
    `-s "${appDir}"`,
    `-d "${buildDir}"`,
    `--board=${options.board}`,
    "--",
    ...cmakeArgs,
  ];
  const cmd = `west ${westArgs.join(" ")}`;

  console.log(`\nCommand:\n  ${cmd}\n`);
  console.log(`SCA output dir: ${scaDir}`);

  // Write the SCA dir path to the output file if requested (useful for CI)
  if (options.scaDirOutput) {
    fs.mkdirSync(path.dirname(path.resolve(options.scaDirOutput)), { recursive: true });
    fs.writeFileSync(options.scaDirOutput, scaDir, "utf8");
    log(`SCA dir path written to: ${options.scaDirOutput}`);
  }

  if (options.dryRun) {
    console.log("(dry-run: not executing)");
    return;
  }

  // 8. Run
  log(`Running analysis in: ${appDir}`);
  await run_command(cmd, appDir);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function create_user_ruleset(
  eclair_options: string[],
  dir?: string,
  name?: string,
): { user_ruleset_name: string; user_ruleset_path: string } {
  const ruleset_path = dir ?? path.join(os.tmpdir(), "zw_eclair_user_ruleset");
  const ruleset_name = name ?? "zw_cli";
  const ecl = path.join(ruleset_path, `analysis_${ruleset_name}.ecl`);

  fs.mkdirSync(ruleset_path, { recursive: true });
  fs.rmSync(ecl, { force: true });
  fs.writeFileSync(ecl, eclair_options.join("\n"), { encoding: "utf8" });

  return { user_ruleset_name: ruleset_name, user_ruleset_path: ruleset_path };
}

function write_options_wrapper(
  additional_options: string[],
  extra_config: string | undefined,
): string {
  const wrapperPath = path.join(os.tmpdir(), "zw_eclair_wrapper.cmake");
  let content = "";

  for (const opt of additional_options) {
    content += `list(APPEND ECLAIR_ENV_ADDITIONAL_OPTIONS "${opt.replace(/"/g, '\\"')}")\n`;
  }

  if (extra_config && fs.existsSync(extra_config) && !fs.statSync(extra_config).isDirectory()) {
    const ext = path.extname(extra_config).toLowerCase();
    if (ext !== ".ecl" && ext !== ".eclair") {
      throw new Error(`Unsupported extra_config file extension: ${ext}`);
    }
    content += `list(APPEND ECLAIR_ENV_ADDITIONAL_OPTIONS "-eval_file=${extra_config.replace(/\\/g, "/")}")\n`;
  }

  fs.writeFileSync(wrapperPath, content, { encoding: "utf8" });
  return wrapperPath;
}

async function resolve_all_repo_revs(
  repos: EclairRepos,
  log: (...args: any[]) => void,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(repos)) {
    if (entry.rev) {
      result[name] = entry.rev;
    } else {
      log(`Resolving ref '${entry.ref}' for repo '${name}'...`);
      const rev = await resolve_ref_to_rev(entry.origin, entry.ref);
      if (!rev) {
        throw new Error(`Could not resolve ref '${entry.ref}' for repo '${name}'`);
      }
      result[name] = rev;
    }
  }
  return result;
}

function run_command(cmd: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, { cwd, shell: true, stdio: "inherit", env: {
      ...process.env,
      CCACHE_DISABLE: "1",
    }});
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}
