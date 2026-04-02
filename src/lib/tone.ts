import type { Client } from "@notionhq/client";

export type ToneSectionField = "voiceSummary" | "preferredPatterns" | "avoid";

export function classifyToneSection(heading: string): ToneSectionField | null {
  const h = heading.toLowerCase();
  if (!h) return null;

  // Avoid bucket — check first (most specific patterns)
  if (/anti[- ]?mod[eè]le|ne\s+(dit|faut)\s+(jamais|pas)|ne\s+faut\s+pas|r[eè]gles|[àa]\s+[ée]viter|avoid/.test(h)) return "avoid";

  // Preferred patterns bucket
  if (/structur|lexique|adaptation|format|conversion|oral.*[ée]crit|preferred|pattern/.test(h)) return "preferredPatterns";

  // Voice summary bucket
  if (/qui\s+est|voix|d[eé]finit|voice|summary|tone\b|profil/.test(h)) return "voiceSummary";

  return null;
}

export function normalizeToneText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-•*]\s+/, ""))
    .map((line) => line.replace(/ {2,}/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseToneBodySections(sections: Map<string, string>): {
  voiceSummary: string;
  preferredPatterns: string;
  avoid: string;
} {
  const buckets: Record<ToneSectionField, string[]> = {
    voiceSummary: [],
    preferredPatterns: [],
    avoid: []
  };

  for (const [heading, content] of sections) {
    const field = classifyToneSection(heading);
    if (field && content.trim()) {
      buckets[field].push(content);
    }
  }

  return {
    voiceSummary: normalizeToneText(buckets.voiceSummary.join("\n\n")),
    preferredPatterns: normalizeToneText(buckets.preferredPatterns.join("\n\n")),
    avoid: normalizeToneText(buckets.avoid.join("\n\n"))
  };
}

export async function readPageBodySections(client: Client, pageId: string): Promise<Map<string, string>> {
  const sections = new Map<string, string>();
  let currentHeading = "";

  const collectBlocks = async (blockId: string, depth: number) => {
    let startCursor: string | undefined;

    do {
      const response = await client.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        start_cursor: startCursor
      });

      for (const block of response.results) {
        if (!("type" in block)) continue;
        const b = block as any;
        const type: string = b.type;

        const richText = b[type]?.rich_text;
        const text = Array.isArray(richText)
          ? richText.map((t: { plain_text: string }) => t.plain_text ?? "").join("").trim()
          : "";

        if (type.startsWith("heading_")) {
          currentHeading = text.toLowerCase();
          if (currentHeading && !sections.has(currentHeading)) {
            sections.set(currentHeading, "");
          }
        } else if (text) {
          const existing = sections.get(currentHeading) ?? "";
          sections.set(currentHeading, existing ? `${existing}\n${text}` : text);
        }

        if (b.has_children && depth < 2) {
          await collectBlocks(b.id, depth + 1);
        }
      }

      startCursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (startCursor);
  };

  await collectBlocks(pageId, 0);
  return sections;
}

export async function readToneOfVoiceProfiles(client: Client, databaseId: string): Promise<Array<{
  pageId: string;
  profileName: string;
  voiceSummary: string;
  preferredPatterns: string;
  avoid: string;
  source: "properties" | "body";
}>> {
  const results: Array<{ pageId: string; profileName: string; voiceSummary: string; preferredPatterns: string; avoid: string; source: "properties" | "body" }> = [];
  let startCursor: string | undefined;

  do {
    const response = await client.databases.query({
      database_id: databaseId,
      start_cursor: startCursor
    });

    for (const page of response.results.filter((r) => r.object === "page")) {
      const p = page as any;
      const text = (prop: string) => {
        const val = p.properties[prop];
        if (val?.type === "rich_text") return val.rich_text.map((t: { plain_text: string }) => t.plain_text).join("");
        if (val?.type === "title") return val.title.map((t: { plain_text: string }) => t.plain_text).join("");
        return "";
      };

      let voiceSummary = text("Voice summary");
      let preferredPatterns = text("Preferred patterns");
      let avoid = text("Avoid");
      let source: "properties" | "body" = "properties";

      const propertiesEmpty = !voiceSummary && !preferredPatterns && !avoid;
      if (propertiesEmpty) {
        const sections = await readPageBodySections(client, p.id);
        const parsed = parseToneBodySections(sections);
        voiceSummary = parsed.voiceSummary;
        preferredPatterns = parsed.preferredPatterns;
        avoid = parsed.avoid;
        source = "body";
      }

      results.push({
        pageId: p.id,
        profileName: text("Profile"),
        voiceSummary,
        preferredPatterns,
        avoid,
        source
      });
    }

    startCursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (startCursor);

  return results;
}
