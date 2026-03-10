import path from "node:path";
import { promises as fs } from "node:fs";

import matter from "gray-matter";

import type {
  ClaapSourceConfig,
  ConnectorConfig,
  LinearSourceConfig,
  MarketFindingsSourceConfig,
  NotionSourceConfig,
  ProfileBase,
  SlackSourceConfig
} from "../domain/types.js";
import { PROFILE_IDS } from "../domain/types.js";
import { listFilesRecursive, readJsonFile } from "../lib/fs.js";
import { hashParts } from "../lib/ids.js";
import {
  claapSourceConfigSchema,
  linearSourceConfigSchema,
  marketFindingsSourceConfigSchema,
  notionSourceConfigSchema,
  slackSourceConfigSchema
} from "./schema.js";

const projectRoot = process.cwd();

export async function loadConnectorConfigs(): Promise<ConnectorConfig[]> {
  const sourcesDirectory = path.join(projectRoot, "config", "sources");
  const files = await listFilesRecursive(sourcesDirectory);
  const jsonFiles = files.filter((file) => file.endsWith(".json"));
  const configs = await Promise.all(
    jsonFiles.map(async (file) => {
      const value = await readJsonFile<unknown>(file);
      const source = (value as { source?: string }).source;
      switch (source) {
        case "slack":
          return slackSourceConfigSchema.parse(value) as SlackSourceConfig;
        case "notion":
          return notionSourceConfigSchema.parse(value) as NotionSourceConfig;
        case "claap":
          return claapSourceConfigSchema.parse(value) as ClaapSourceConfig;
        case "linear":
          return linearSourceConfigSchema.parse(value) as LinearSourceConfig;
        case "market-findings":
          return marketFindingsSourceConfigSchema.parse(value) as MarketFindingsSourceConfig;
        default:
          throw new Error(`Unsupported source config in ${file}`);
      }
    })
  );

  return configs.sort((left, right) => left.source.localeCompare(right.source));
}

export async function loadDoctrineMarkdown() {
  const doctrinePath = path.join(projectRoot, "editorial", "doctrine.md");
  return fs.readFile(doctrinePath, "utf8");
}

export async function loadSensitivityMarkdown() {
  const sensitivityPath = path.join(projectRoot, "editorial", "sensitivity-rules.md");
  return fs.readFile(sensitivityPath, "utf8");
}

export async function loadProfileBases(): Promise<ProfileBase[]> {
  const profilesDirectory = path.join(projectRoot, "editorial", "profiles");
  const files = await listFilesRecursive(profilesDirectory);
  const markdownFiles = files.filter((file) => file.endsWith(".md"));
  const profiles = await Promise.all(
    markdownFiles.map(async (file) => {
      const contents = await fs.readFile(file, "utf8");
      const parsed = matter(contents);
      const profileId = parsed.data.profileId as string;
      if (!PROFILE_IDS.includes(profileId as (typeof PROFILE_IDS)[number])) {
        throw new Error(`Unknown profileId "${profileId}" in ${file}`);
      }

      return {
        profileId: profileId as ProfileBase["profileId"],
        role: String(parsed.data.role ?? ""),
        languagePreference: String(parsed.data.languagePreference ?? "fr"),
        toneSummary: String(parsed.data.toneSummary ?? ""),
        preferredStructure: String(parsed.data.preferredStructure ?? ""),
        typicalPhrases: ensureStringArray(parsed.data.typicalPhrases),
        avoidRules: ensureStringArray(parsed.data.avoidRules),
        contentTerritories: ensureStringArray(parsed.data.contentTerritories),
        weakFitTerritories: ensureStringArray(parsed.data.weakFitTerritories),
        sampleExcerpts: extractBulletList(parsed.content),
        sourcePath: file,
        notionPageFingerprint: hashParts(["profile", profileId, file])
      } satisfies ProfileBase;
    })
  );

  return profiles.sort((left, right) => left.profileId.localeCompare(right.profileId));
}

export async function loadMarketFindingsMarkdown() {
  const directory = path.join(projectRoot, "editorial", "market-findings");
  const files = (await listFilesRecursive(directory)).filter((file) => file.endsWith(".md"));
  return Promise.all(
    files.map(async (file) => {
      const contents = await fs.readFile(file, "utf8");
      const parsed = matter(contents);
      return {
        id: parsed.data.id ?? path.basename(file, ".md"),
        finding: parsed.data.finding ?? parsed.content.trim(),
        theme: parsed.data.theme ?? "General",
        source: parsed.data.source ?? "Markdown",
        confidence: Number(parsed.data.confidence ?? 0.6),
        possibleOwner: parsed.data.possibleOwner ?? null,
        editorialAngle: parsed.data.editorialAngle ?? "",
        status: parsed.data.status ?? "New",
        filePath: file
      };
    })
  );
}

function ensureStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }

  return [];
}

function extractBulletList(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}
