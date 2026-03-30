import type { AppEnv } from "../config/env.js";
import { loadConnectorConfigs, loadDoctrineMarkdown, loadProfileBases, loadSensitivityMarkdown } from "../config/loaders.js";
import { PROFILE_IDS, type CompanyRecord, type EditorialConfigRecord, type ProfileBase, type SourceConfigRecord, type UserRecord } from "../domain/types.js";
import { createDeterministicId, hashParts } from "../lib/ids.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { NotionService } from "./notion.js";

/** Narrow a Prisma JsonValue to Record<string, unknown>, returning undefined for non-objects. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function ensureConvergenceFoundation(
  repositories: RepositoryBundle,
  env: AppEnv,
  notion?: NotionService
): Promise<CompanyRecord> {
  if (typeof (repositories as Partial<RepositoryBundle>).ensureDefaultCompany !== "function") {
    return {
      id: "company_default",
      slug: env.DEFAULT_COMPANY_SLUG ?? "default",
      name: env.DEFAULT_COMPANY_NAME ?? "Default Company",
      defaultTimezone: env.DEFAULT_TIMEZONE ?? "Europe/Paris",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  const company = await repositories.ensureDefaultCompany({
    slug: env.DEFAULT_COMPANY_SLUG ?? "default",
    name: env.DEFAULT_COMPANY_NAME ?? "Default Company",
    defaultTimezone: env.DEFAULT_TIMEZONE ?? "Europe/Paris"
  });

  const [profiles, sourceConfigs, doctrineMarkdown, sensitivityMarkdown, existingEditorialConfig] = await Promise.all([
    loadProfileBases(),
    loadConnectorConfigs(),
    loadDoctrineMarkdown(),
    loadSensitivityMarkdown(),
    repositories.getLatestEditorialConfig(company.id)
  ]);

  // Merge Tone of voice from Notion if available
  const toneOverrides = await loadToneOfVoiceOverrides(notion, env.NOTION_TONE_OF_VOICE_DB_ID);
  const mergedProfiles = profiles.map((profile) => applyToneOverride(profile, toneOverrides));

  for (const profile of mergedProfiles) {
    const user: UserRecord = {
      id: createDeterministicId("user", [company.id, profile.profileId]),
      companyId: company.id,
      displayName: profile.profileId,
      type: profile.profileId === "linc-corporate" ? "corporate" : "human",
      language: profile.languagePreference,
      baseProfile: {
        toneSummary: profile.toneSummary,
        preferredStructure: profile.preferredStructure,
        typicalPhrases: profile.typicalPhrases,
        avoidRules: profile.avoidRules,
        contentTerritories: profile.contentTerritories,
        weakFitTerritories: profile.weakFitTerritories,
        sampleExcerpts: profile.sampleExcerpts
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await repositories.upsertUser(user);
  }

  for (const sourceConfig of sourceConfigs) {
    const dbConfig: SourceConfigRecord = {
      id: createDeterministicId("source-config", [company.id, sourceConfig.source]),
      companyId: company.id,
      source: sourceConfig.source,
      enabled: sourceConfig.enabled,
      configJson: sourceConfig as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await repositories.upsertSourceConfig(dbConfig);
  }

  const currentDoctrineHash = hashParts(["layer1", doctrineMarkdown, sensitivityMarkdown]);
  const existingLayer1 = asRecord(existingEditorialConfig?.layer1CompanyLens);
  const storedDoctrineHash = existingLayer1
    ? hashParts(["layer1", String(existingLayer1.doctrineMarkdown ?? ""), String(existingLayer1.sensitivityMarkdown ?? "")])
    : null;

  if (!existingEditorialConfig || currentDoctrineHash !== storedDoctrineHash) {
    const editorialConfig: EditorialConfigRecord = {
      id: existingEditorialConfig?.id ?? createDeterministicId("editorial-config", [company.id, "1"]),
      companyId: company.id,
      version: existingEditorialConfig?.version ?? 1,
      layer1CompanyLens: {
        doctrineMarkdown,
        sensitivityMarkdown
      },
      layer2ContentPhilosophy: asRecord(existingEditorialConfig?.layer2ContentPhilosophy) ?? {
        defaults: [
          "Specific",
          "Evidence-backed",
          "Current",
          "Useful",
          "Non-generic"
        ]
      },
      layer3LinkedInCraft: asRecord(existingEditorialConfig?.layer3LinkedInCraft) ?? {
        defaults: [
          "Max 250 words. One idea per post.",
          "First 2 lines must create a reason to click voir plus. No descriptive openings.",
          "Plain text. No emoji headers. No bold. No numbered sections.",
          "Write like a person, not a framework. First person mandatory.",
          "End with something worth reacting to. Not a summary.",
          "Never cite internal source systems. Transform evidence into personal observation.",
          "Vary structure across posts. Never repeat the same skeleton."
        ]
      },
      createdAt: existingEditorialConfig?.createdAt
        ? (typeof existingEditorialConfig.createdAt === "string"
            ? existingEditorialConfig.createdAt
            : existingEditorialConfig.createdAt.toISOString())
        : new Date().toISOString()
    };
    await repositories.upsertEditorialConfig(editorialConfig);
  }

  return company;
}

type ToneOverride = {
  toneSummary: string;
  preferredStructure: string;
  avoidRules: string[];
};

export function resolveProfileId(profileName: string): string | undefined {
  const words = profileName.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;

  const matches = words.filter((w) => (PROFILE_IDS as readonly string[]).includes(w));
  if (matches.length === 1) return matches[0];
  // Ambiguous (multiple matches) or no match — skip
  return undefined;
}

async function loadToneOfVoiceOverrides(
  notion: NotionService | undefined,
  databaseId: string | undefined
): Promise<Map<string, ToneOverride>> {
  const overrides = new Map<string, ToneOverride>();
  if (!notion || !databaseId) return overrides;

  const toneProfiles = await notion.readToneOfVoiceProfiles(databaseId);
  for (const tp of toneProfiles) {
    const profileId = resolveProfileId(tp.profileName);
    if (!profileId) {
      console.warn(`[tone-of-voice] Skipping unmatched profile name: "${tp.profileName}"`);
      continue;
    }

    overrides.set(profileId, {
      toneSummary: tp.voiceSummary,
      preferredStructure: tp.preferredPatterns,
      avoidRules: tp.avoid.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
    });
  }

  return overrides;
}

function applyToneOverride(profile: ProfileBase, overrides: Map<string, ToneOverride>): ProfileBase {
  const override = overrides.get(profile.profileId);
  if (!override) return profile;

  return {
    ...profile,
    toneSummary: override.toneSummary || profile.toneSummary,
    preferredStructure: override.preferredStructure || profile.preferredStructure,
    avoidRules: override.avoidRules.length > 0 ? override.avoidRules : profile.avoidRules
  };
}
