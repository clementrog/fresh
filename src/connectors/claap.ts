import type { AppEnv } from "../config/env.js";
import type {
  ClaapSourceConfig,
  NormalizedSourceItem,
  RawSourceItem,
  RunContext
} from "../domain/types.js";
import { hashParts } from "../lib/ids.js";
import { inferClaapSignalProfileHint } from "../lib/profile-hints.js";
import { claapSignalExtractionSchema } from "../config/schema.js";
import type { LlmClient } from "../services/llm.js";
import { BaseConnector } from "./base.js";

interface TranscriptSegment {
  speaker: string;
  text: string;
  startedAt?: number;
  endedAt?: number;
}

type RoutingDecision = "create_opportunity" | "support_only" | "ignore";

function buildSignalExtractionSystem(doctrineMarkdown?: string): string {
  const sections: string[] = [];

  sections.push(`You are an editorial signal extractor for a French LinkedIn content pipeline.
Analyze this Claap recording transcript and determine if it contains an actionable
editorial signal — a concrete proof point, pain point, adoption signal, market shift,
or customer insight worth turning into a LinkedIn post.

If the transcript is a routine internal meeting, training session, or contains no
specific editorial insight, set hasSignal to false and routingDecision to "ignore".

## Routing Decision

Set routingDecision to one of:
- "create_opportunity": Strong signal worthy of a new content opportunity. Clear proof point,
  sharp pain point, measurable adoption signal, or concrete customer insight with a publishable angle.
- "support_only": Has evidence value (quotes, context, data points) but not strong enough alone
  to justify a standalone post. Useful for enriching an existing opportunity later.
- "ignore": No editorial signal. Routine internal meeting, training, or generic discussion.

If hasSignal is false, routingDecision MUST be "ignore".
If hasSignal is true, choose between "create_opportunity" and "support_only" based on signal strength.

If it contains a signal, extract:
- title: A concise signal title (French)
- summary: What the signal is about (2-3 sentences, French)
- hookCandidate: A potential opening line for a LinkedIn post (French)
- whyItMatters: Why this matters now (1-2 sentences, French)
- excerpts: 1-3 key verbatim quotes from the transcript (most impactful)
- signalType: One of "Proof point", "Pain point", "Adoption signal", "Market shift", "Customer insight"
- theme: One of "Compliance", "Product adoption", "Market shift", "Operations", "Sales"
- confidenceScore: 0.0-1.0 confidence that this is worth a LinkedIn post`);

  if (doctrineMarkdown) {
    sections.push(`\n## Company Doctrine\n${doctrineMarkdown}`);
  }

  sections.push(`\n## Brand Safety

Assess every signal for publishability risk. A signal that is factually interesting but would damage the company's brand if published on LinkedIn must be flagged.

Set publishabilityRisk to one of:
- "safe": The signal can be published as-is without brand risk.
- "reframeable": The signal contains useful substance but its current framing would damage the brand. Provide a reframingSuggestion explaining how to reframe it safely.
- "harmful": The signal would damage the brand even if reframed (e.g., a customer saying they don't trust the product, a complaint about core reliability, negative competitive comparison).

Calibration examples:
- Customer says "your compliance automation saved us 40 hours/month" → safe
- Customer says "we had doubts about accuracy but after testing it works" → reframeable (reframe: focus on the validation outcome, not the doubt)
- Customer says "they don't trust the accuracy" or "DSN is the huge blocking point" → harmful
- Prospect describes a pain point the product solves → safe
- Prospect describes a pain point AND says the product doesn't solve it → harmful

When in doubt, choose harmful.

If publishabilityRisk is "reframeable", you MUST provide reframingSuggestion.`);

  return sections.join("\n");
}

export class ClaapConnector extends BaseConnector<ClaapSourceConfig> {
  readonly source = "claap" as const;

  constructor(
    private readonly env: AppEnv,
    private readonly llmClient?: LlmClient,
    private readonly doctrineMarkdown?: string
  ) {
    super();
  }

  override async fetchSince(cursor: string | null, config: ClaapSourceConfig, _context: RunContext): Promise<RawSourceItem[]> {
    if (!config.enabled || !this.env.CLAAP_API_KEY) {
      return [];
    }

    const items: RawSourceItem[] = [];

    const response = await this.executeWithRateLimit(config, () =>
      fetch("https://api.claap.io/v1/recordings", {
        headers: {
          "X-Claap-Key": this.env.CLAAP_API_KEY!
        }
      })
    );

    if (!response.ok) {
      return [];
    }

    const body = (await response.json()) as {
      result?: { recordings?: Array<Record<string, unknown>> }
    };
    const recordings = body.result?.recordings ?? [];

    let count = 0;
    for (const recording of recordings) {
      const updatedAt = String(recording.updatedAt ?? recording.createdAt ?? "");
      if (cursor && updatedAt <= cursor) {
        continue;
      }

      // workspaceIds scoping: skip recordings from other workspaces.
      // If the recording has no workspaceId (field absent from API response), let it through
      // rather than silently dropping data — the API key may already scope to one workspace.
      const recordingWs = recording.workspaceId != null ? String(recording.workspaceId) : undefined;
      if (config.workspaceIds.length > 0 && recordingWs !== undefined && !config.workspaceIds.includes(recordingWs)) {
        continue;
      }

      if (config.folderIds.length > 0 && !config.folderIds.includes(String(recording.folderId ?? ""))) {
        continue;
      }

      if (count >= config.maxRecordingsPerRun) {
        break;
      }

      // Fetch transcript for each recording
      const recordingId = String(recording.id);
      const segments = await this.fetchTranscript(recordingId, config);
      const assembledTranscript = assembleTranscript(segments);

      items.push({
        id: recordingId,
        cursor: updatedAt,
        payload: {
          ...recording,
          transcriptSegments: segments,
          assembledTranscript
        }
      });
      count += 1;
    }

    return items;
  }

  override async normalize(rawItem: RawSourceItem, config: ClaapSourceConfig, context: RunContext): Promise<NormalizedSourceItem> {
    const payload = rawItem.payload as {
      id?: string;
      title?: string;
      summary?: string;
      url?: string;
      updatedAt?: string;
      createdAt?: string;
      speaker?: string;
      transcriptSegments?: TranscriptSegment[];
      assembledTranscript?: string;
    };
    const transcript = payload.assembledTranscript ?? "";
    const segments = payload.transcriptSegments ?? [];
    const sourceItemId = String(payload.id ?? rawItem.id);
    const occurredAt = payload.updatedAt ?? payload.createdAt ?? context.now.toISOString();

    // Attempt LLM signal extraction if transcript is substantial
    if (this.llmClient && transcript.length >= 100) {
      try {
        const extraction = await this.extractSignal(transcript);
        if (extraction && extraction.hasSignal) {
          const risk = extraction.publishabilityRisk ?? "safe";

          // Derive routing decision from LLM output, with fallback for old responses
          let routing: RoutingDecision = extraction.routingDecision ?? "ignore";
          if (routing === "ignore" && extraction.hasSignal) {
            // Backward compat: old LLM responses lack routingDecision
            routing = extraction.confidenceScore >= 0.7 ? "create_opportunity" : "support_only";
          }

          // Publishability gate: harmful/reframeable cannot create opportunities
          if (routing === "create_opportunity" && risk !== "safe") {
            routing = "support_only";
          }

          const profileHint = inferClaapSignalProfileHint({
            signalType: extraction.signalType,
            theme: extraction.theme,
            title: extraction.title,
            summary: extraction.summary,
            hookCandidate: extraction.hookCandidate,
            whyItMatters: extraction.whyItMatters,
            excerpts: extraction.excerpts,
            speakerContext: payload.speaker ?? undefined
          });

          const text = [
            extraction.title,
            extraction.hookCandidate,
            extraction.summary,
            extraction.whyItMatters,
            extraction.signalType,
            extraction.theme,
            ...extraction.excerpts
          ]
            .filter(Boolean)
            .join("\n");

          const summaryText = [
            extraction.summary,
            extraction.whyItMatters ? `Why it matters: ${extraction.whyItMatters}` : ""
          ]
            .filter(Boolean)
            .join(" ");

          // Determine signalKind and fingerprint based on routing + risk
          const signalKind = routing === "create_opportunity" ? "claap-signal"
            : (risk === "reframeable" ? "claap-signal-reframeable" : undefined);

          const fingerprintTag = routing === "create_opportunity" ? "claap-signal"
            : (risk === "reframeable" ? "claap-signal-reframeable" : undefined);

          const sourceFingerprint = fingerprintTag
            ? hashParts([
                "claap",
                fingerprintTag,
                sourceItemId,
                extraction.title,
                extraction.signalType,
                extraction.theme,
                occurredAt
              ])
            : hashParts(["claap", sourceItemId, occurredAt, transcript]);

          const confidenceScore = risk === "reframeable"
            ? Math.min(extraction.confidenceScore * 0.6, 0.5)
            : extraction.confidenceScore;

          const metadata: Record<string, unknown> = {
            storeRawText: config.storeRawText,
            routingDecision: routing,
            theme: extraction.theme,
            signalTypeLabel: extraction.signalType,
            profileHint,
            hookCandidate: extraction.hookCandidate,
            whyItMatters: extraction.whyItMatters,
            confidenceScore,
            publishabilityRisk: risk
          };
          if (signalKind) metadata.signalKind = signalKind;
          if (extraction.reframingSuggestion) metadata.reframingSuggestion = extraction.reframingSuggestion;

          // For harmful items, use original title (not extracted) and transcript as text
          const useExtractedContent = risk !== "harmful";

          return {
            source: "claap",
            sourceItemId,
            externalId: `claap:${sourceItemId}`,
            sourceFingerprint,
            sourceUrl: payload.url ?? "",
            title: useExtractedContent ? extraction.title : (payload.title ?? `Claap recording ${rawItem.id}`),
            text: useExtractedContent ? text : transcript,
            summary: useExtractedContent ? summaryText : (payload.summary ?? transcript.slice(0, 200)),
            speakerName: payload.speaker,
            occurredAt,
            ingestedAt: context.now.toISOString(),
            metadata,
            rawPayload: rawItem.payload,
            rawText: config.storeRawText ? transcript : null,
            chunks: useExtractedContent && extraction.excerpts.length > 0
              ? extraction.excerpts
              : chunkTranscript(transcript, segments)
          };
        }
      } catch {
        // LLM failure: fall through to plain item (safe fallback)
      }
    }

    // No signal or no LLM: plain item with ignore routing
    return {
      source: "claap",
      sourceItemId,
      externalId: `claap:${sourceItemId}`,
      sourceFingerprint: hashParts(["claap", sourceItemId, occurredAt, transcript]),
      sourceUrl: payload.url ?? "",
      title: payload.title ?? `Claap recording ${rawItem.id}`,
      text: transcript,
      summary: payload.summary ?? transcript.slice(0, 200),
      speakerName: payload.speaker,
      occurredAt,
      ingestedAt: context.now.toISOString(),
      metadata: {
        storeRawText: config.storeRawText,
        routingDecision: "ignore" as RoutingDecision
      },
      rawPayload: rawItem.payload,
      rawText: config.storeRawText ? transcript : null,
      chunks: chunkTranscript(transcript, segments)
    };
  }

  override async backfill(range: { from: Date; to: Date }, config: ClaapSourceConfig, context: RunContext): Promise<RawSourceItem[]> {
    return this.fetchSince(range.from.toISOString(), config, {
      dryRun: false,
      now: context.now
    });
  }

  private async fetchTranscript(recordingId: string, config: ClaapSourceConfig): Promise<TranscriptSegment[]> {
    if (!this.env.CLAAP_API_KEY) {
      return [];
    }

    try {
      const response = await this.executeWithRateLimit(config, () =>
        fetch(`https://api.claap.io/v1/recordings/${recordingId}/transcript`, {
          headers: {
            "X-Claap-Key": this.env.CLAAP_API_KEY!
          }
        })
      );

      if (!response.ok) {
        return [];
      }

      const body = (await response.json()) as {
        result?: { transcript?: { segments?: TranscriptSegment[] } }
      };
      return body.result?.transcript?.segments ?? [];
    } catch {
      return [];
    }
  }

  private async extractSignal(transcript: string) {
    if (!this.llmClient) return null;

    const noSignalFallback = () => ({
      hasSignal: false as const,
      title: "",
      summary: "",
      hookCandidate: "",
      whyItMatters: "",
      excerpts: [] as string[],
      signalType: "",
      theme: "",
      confidenceScore: 0,
      publishabilityRisk: "safe" as const
    });

    const response = await this.llmClient.generateStructured({
      step: "claap-signal-extraction",
      system: buildSignalExtractionSystem(this.doctrineMarkdown),
      prompt: `Transcript:\n\n${transcript.slice(0, 8000)}`,
      schema: claapSignalExtractionSchema,
      allowFallback: true,
      fallback: noSignalFallback
    });

    return response.output;
  }
}

function assembleTranscript(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return "";
  return segments
    .map((s) => `[${s.speaker}] ${s.text}`)
    .join("\n");
}

function chunkTranscript(transcript: string, segments?: TranscriptSegment[]) {
  if (!transcript.trim()) {
    return [];
  }

  // When segments with speakers are available, chunk by speaker turns
  if (segments && segments.length > 0) {
    const chunks: string[] = [];
    let current = "";
    for (const segment of segments) {
      const line = `[${segment.speaker}] ${segment.text}`;
      if (current.length + line.length > 500 && current.length > 0) {
        chunks.push(current.trim());
        current = line;
      } else {
        current += (current ? "\n" : "") + line;
      }
    }
    if (current.trim()) {
      chunks.push(current.trim());
    }
    return chunks;
  }

  // Fallback: naive 500-char slicing
  const size = 500;
  const chunks: string[] = [];
  for (let index = 0; index < transcript.length; index += size) {
    chunks.push(transcript.slice(index, index + size));
  }
  return chunks;
}
