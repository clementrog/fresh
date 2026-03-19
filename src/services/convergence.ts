import type { AppEnv } from "../config/env.js";
import { loadConnectorConfigs, loadDoctrineMarkdown, loadProfileBases, loadSensitivityMarkdown } from "../config/loaders.js";
import type { CompanyRecord, EditorialConfigRecord, ProfileBase, SourceConfigRecord, UserRecord } from "../domain/types.js";
import { createDeterministicId } from "../lib/ids.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { NotionService } from "./notion.js";

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

  if (!existingEditorialConfig) {
    const editorialConfig: EditorialConfigRecord = {
      id: createDeterministicId("editorial-config", [company.id, "1"]),
      companyId: company.id,
      version: 1,
      layer1CompanyLens: {
        doctrineMarkdown,
        sensitivityMarkdown
      },
      layer2ContentPhilosophy: {
        defaults: [
          "Specific",
          "Evidence-backed",
          "Current",
          "Useful",
          "Non-generic"
        ]
      },
      layer3LinkedInCraft: {
        defaults: [
          "Strong hook",
          "Concrete lesson",
          "Proof before opinion"
        ]
      },
      createdAt: new Date().toISOString()
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

async function loadToneOfVoiceOverrides(
  notion: NotionService | undefined,
  databaseId: string | undefined
): Promise<Map<string, ToneOverride>> {
  const overrides = new Map<string, ToneOverride>();
  if (!notion || !databaseId) return overrides;

  const toneProfiles = await notion.readToneOfVoiceProfiles(databaseId);
  for (const tp of toneProfiles) {
    // Match by first name (lowercase): "Baptiste Le Bihan" → "baptiste"
    const firstName = tp.profileName.split(" ")[0]?.toLowerCase();
    if (!firstName) continue;

    overrides.set(firstName, {
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
