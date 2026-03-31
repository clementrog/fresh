import { PROFILE_IDS } from "../domain/types.js";
import type { ProfileId, NormalizedSourceItem, UserRecord } from "../domain/types.js";

export type SpeakerContextSource = "identity" | "content-hint";

export interface ResolvedSpeakerContext {
  profileId: ProfileId;
  role: string;
  speakerName: string;
  source: SpeakerContextSource;
}

/**
 * Resolve speaker context from upstream signals.
 *
 * Resolution order (identity-first, complete-or-nothing):
 * 1. Explicit identity — speakerName matches a user's speakerAliases (case-insensitive).
 *    If alias matches but role is missing, returns undefined (does NOT fall through to hint).
 *    If speakerName is present but no alias matches, returns undefined — a named speaker
 *    that fails identity matching is treated as external / unknown, never labeled via
 *    content-derived hints (which would risk misattributing third-party voices).
 * 2. Content-derived fallback — ONLY when no explicit speakerName exists.
 *    metadata.profileHint maps to a user with a non-empty role, and a non-empty authorName
 *    is available for rendering.
 * 3. Otherwise undefined — no prompt modification will occur.
 *
 * Never reads ownerSuggestion or any screening/routing output.
 */
export function resolveSpeakerContext(params: {
  item: NormalizedSourceItem;
  users: UserRecord[];
}): ResolvedSpeakerContext | undefined {
  const { item, users } = params;
  const rawName = item.speakerName?.trim() || "";

  // --- Step 1: Explicit identity via alias matching ---
  if (rawName.length > 0) {
    const lowerName = rawName.toLowerCase();
    for (const user of users) {
      const bp = user.baseProfile as Record<string, unknown>;
      const aliases = Array.isArray(bp.speakerAliases) ? (bp.speakerAliases as string[]) : [];
      if (aliases.some(alias => alias.toLowerCase() === lowerName)) {
        const role = typeof bp.role === "string" ? bp.role.trim() : "";
        if (role.length === 0) return undefined; // complete-or-nothing: don't fall through
        return { profileId: user.displayName as ProfileId, role, speakerName: rawName, source: "identity" };
      }
    }
    // Named speaker present but no alias matched — treat as external / unknown.
    // Do NOT fall through to content-hint: that would risk labeling a third-party
    // voice (e.g., a prospect on a Claap call) as an internal role.
    return undefined;
  }

  // --- Step 2: Content-derived fallback (no explicit speaker identity) ---
  // Only reached when speakerName is absent. Uses profileHint + authorName.
  const hint = typeof item.metadata?.profileHint === "string" ? item.metadata.profileHint : "";
  if (hint.length > 0 && PROFILE_IDS.includes(hint as ProfileId)) {
    const user = users.find(u => u.displayName === hint);
    if (user) {
      const bp = user.baseProfile as Record<string, unknown>;
      const role = typeof bp.role === "string" ? bp.role.trim() : "";
      const name = item.authorName?.trim() || "";
      if (role.length > 0 && name.length > 0) {
        return { profileId: hint as ProfileId, role, speakerName: name, source: "content-hint" };
      }
    }
  }

  return undefined;
}

/**
 * Build the system-prompt injection block for extraction depth.
 * Only called when activation predicate is true.
 */
export function buildExtractionDepthBlock(ctx: ResolvedSpeakerContext, profilesMarkdown: string): string {
  return [
    "## Extraction depth by speaker role",
    profilesMarkdown,
    "",
    `Active speaker context: ${ctx.speakerName} (${ctx.role}, resolved via ${ctx.source}).`,
    "Apply the extraction depth matching this role. Speaker role shapes what to extract; the suggested owner (in Available owners above) shapes who might publish it. These may differ."
  ].join("\n");
}
