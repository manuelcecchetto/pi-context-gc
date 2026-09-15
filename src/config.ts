import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextGcConfig, LoadedConfig } from "./types.ts";

export const DEFAULT_CONFIG: ContextGcConfig = {
  enabled: true,
  autoResume: true,
  resumeOnFailure: false,
  notify: false,
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readJson(path: string): { value?: UnknownRecord; warning?: string } {
  try {
    const value = asRecord(JSON.parse(readFileSync(path, "utf8")));
    return value
      ? { value }
      : { warning: `${path}: root value must be a JSON object` };
  } catch (error) {
    const code = asRecord(error)?.code;
    if (code === "ENOENT") return {};
    return {
      warning: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function mergeBoolean(
  target: ContextGcConfig,
  source: UnknownRecord,
  key: keyof ContextGcConfig,
  warnings: string[],
  sourceName: string,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    warnings.push(`${sourceName}: ${String(key)} must be boolean`);
    return;
  }
  target[key] = value;
}

function applySource(
  target: ContextGcConfig,
  source: UnknownRecord,
  warnings: string[],
  sourceName: string,
): void {
  mergeBoolean(target, source, "enabled", warnings, sourceName);
  mergeBoolean(target, source, "autoResume", warnings, sourceName);
  mergeBoolean(target, source, "resumeOnFailure", warnings, sourceName);
  mergeBoolean(target, source, "notify", warnings, sourceName);
}

function envBoolean(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return undefined;
}

export function loadConfig(ctx: ExtensionContext): LoadedConfig {
  const globalPath = join(homedir(), ".pi", "agent", "context-gc.json");
  const projectPath = join(ctx.cwd, ".pi", "context-gc.json");
  const config = { ...DEFAULT_CONFIG };
  const warnings: string[] = [];
  const loadedSources: string[] = [];

  const global = readJson(globalPath);
  if (global.warning) warnings.push(global.warning);
  if (global.value) {
    applySource(config, global.value, warnings, globalPath);
    loadedSources.push(globalPath);
  }

  let trusted = false;
  try {
    trusted = ctx.isProjectTrusted();
  } catch {
    warnings.push("Could not determine project trust; project-local config was skipped.");
  }

  if (trusted) {
    const project = readJson(projectPath);
    if (project.warning) warnings.push(project.warning);
    if (project.value) {
      applySource(config, project.value, warnings, projectPath);
      loadedSources.push(projectPath);
    }
  }

  const overrides: Array<[keyof ContextGcConfig, string]> = [
    ["enabled", "PI_CONTEXT_GC_ENABLED"],
    ["autoResume", "PI_CONTEXT_GC_AUTO_RESUME"],
    ["resumeOnFailure", "PI_CONTEXT_GC_RESUME_ON_FAILURE"],
    ["notify", "PI_CONTEXT_GC_NOTIFY"],
  ];
  for (const [key, name] of overrides) {
    const value = envBoolean(name);
    if (value !== undefined) config[key] = value;
    else if (process.env[name] !== undefined) {
      warnings.push(`${name} must be one of 1/0, true/false, yes/no, on/off`);
    }
  }

  return { config, globalPath, projectPath, loadedSources, warnings };
}
