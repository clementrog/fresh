import { z } from "zod";
import type { Logger } from "pino";
import type { LlmClient, LlmUsage } from "../../services/llm.js";
import type { SalesRepositoryBundle } from "../db/sales-repositories.js";
import { salesExtractedFactDbId } from "../db/sales-repositories.js";
import { createDeterministicId } from "../../lib/ids.js";
import type { LlmProvider } from "../../domain/types.js";
import type { SalesDoctrineConfig } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_EXTRACTION_ATTEMPTS = 3;
const MIN_BODY_LENGTH = 50;
const MAX_BODY_FOR_LLM = 6_000;
const MAX_SOURCE_TEXT = 500;

// ---------------------------------------------------------------------------
// LLM extraction schema
// ---------------------------------------------------------------------------

export const activityExtractionSchema = z.object({
  painPoints: z.array(z.string()),
  blockers: z.array(z.string()),
  nextStep: z.string().nullable(),
  urgency: z.enum(["none", "low", "medium", "high"]).nullable(),
  competitorMentions: z.array(z.string()),
  budgetMentioned: z.boolean(),
  budgetDetails: z.string().nullable(),
  timelineMentioned: z.boolean(),
  timelineDetails: z.string().nullable(),
  championIdentified: z.string().nullable(),
  decisionMakerMentioned: z.string().nullable(),
  sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
  requestedCapabilities: z.array(z.string()),
  complianceConcerns: z.array(z.string()),
});

export type ActivityExtractionOutput = z.infer<typeof activityExtractionSchema>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  activitiesProcessed: number;
  activitiesSkipped: number;
  stageSkipped: number;
  factsCreated: number;
  retryableErrors: number;
  terminalSkips: number;
  exhaustedItems: number;
  errors: string[];
  warnings: string[];
  costUsd: number;
  rateLimited: boolean;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are a sales activity fact extractor. Analyze the CRM activity text and extract structured facts.

Rules:
- Be conservative: only extract facts that are clearly stated, not implied.
- If the activity is a generic check-in or contains no extractable facts, return empty arrays and nulls.
- For competitor mentions, use the company/product name as-is.
- For pain points and blockers, use short descriptive phrases (3-8 words).
- For urgency, only return "high" if there is explicit time pressure language.
- For sentiment, only return "positive" or "negative" if clearly supported; default to "neutral" or "mixed".
- For champion/decision-maker, return the person's name or role if mentioned.
- Budget and timeline: only set to true if explicitly discussed, not inferred from deal context.`;

// ---------------------------------------------------------------------------
// Fan-out: LLM output → SalesExtractedFact rows
// ---------------------------------------------------------------------------

interface FactParams {
  id: string;
  companyId: string;
  activityId: string;
  dealId: string;
  category: string;
  label: string;
  extractedValue: string;
  confidence: number;
  sourceText: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function fanOutFacts(
  companyId: string,
  activityId: string,
  dealId: string,
  output: ActivityExtractionOutput,
  sourceText: string
): FactParams[] {
  const facts: FactParams[] = [];
  const src = sourceText.slice(0, MAX_SOURCE_TEXT);

  const addFact = (category: string, label: string, extractedValue: string, confidence: number) => {
    const id = salesExtractedFactDbId(companyId, [activityId, category, label]);
    facts.push({ id, companyId, activityId, dealId, category, label, extractedValue, confidence, sourceText: src });
  };

  for (const pp of output.painPoints) {
    if (pp.trim()) addFact("objection_mentioned", `pain:${slugify(pp)}`, pp, 0.8);
  }
  for (const b of output.blockers) {
    if (b.trim()) addFact("objection_mentioned", `blocker:${slugify(b)}`, b, 0.8);
  }
  if (output.nextStep) {
    addFact("urgency_timing", "next_step", output.nextStep, 0.7);
  }
  if (output.urgency && output.urgency !== "none") {
    addFact("urgency_timing", "urgency_level", output.urgency, 0.7);
  }
  for (const comp of output.competitorMentions) {
    if (comp.trim()) addFact("competitor_reference", slugify(comp), comp, 0.9);
  }
  if (output.budgetMentioned) {
    addFact("budget_sensitivity", "budget_mentioned", output.budgetDetails ?? "true", 0.7);
  }
  if (output.timelineMentioned) {
    addFact("urgency_timing", "timeline", output.timelineDetails ?? "true", 0.7);
  }
  if (output.championIdentified) {
    addFact("persona_stakeholder", "champion", output.championIdentified, 0.8);
  }
  if (output.decisionMakerMentioned) {
    addFact("persona_stakeholder", "decision_maker", output.decisionMakerMentioned, 0.8);
  }
  for (const rc of output.requestedCapabilities) {
    if (rc.trim()) addFact("requested_capability", slugify(rc), rc, 0.8);
  }
  for (const cc of output.complianceConcerns) {
    if (cc.trim()) addFact("compliance_security", slugify(cc), cc, 0.8);
  }
  if (output.sentiment && output.sentiment !== "neutral") {
    addFact("sentiment", output.sentiment, output.sentiment, 0.9);
  }

  return facts;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("429") || error.message.toLowerCase().includes("rate limit");
  }
  return false;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("zod") ||
      msg.includes("parse") ||
      msg.includes("did not include content") ||
      msg.includes("did not include text") ||
      msg.includes("missing api key") ||
      msg.includes("request failed with")
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

export async function runExtraction(params: {
  companyId: string;
  repos: SalesRepositoryBundle;
  llmClient: LlmClient;
  logger: Logger;
  provider?: LlmProvider;
  model?: string;
  batchSize?: number;
  runId?: string;
}): Promise<ExtractionResult> {
  const {
    companyId,
    repos,
    llmClient,
    logger,
    provider,
    model,
    batchSize = 50,
  } = params;

  const result: ExtractionResult = {
    activitiesProcessed: 0,
    activitiesSkipped: 0,
    stageSkipped: 0,
    factsCreated: 0,
    retryableErrors: 0,
    terminalSkips: 0,
    exhaustedItems: 0,
    errors: [],
    warnings: [],
    costUsd: 0,
    rateLimited: false,
  };

  const runId = params.runId ?? createDeterministicId("run", [companyId, "sales:extract", Date.now().toString()]);

  // 1. Acquire lease
  await repos.acquireRunLease({ companyId, runType: "sales:extract", runId });

  let leaseLost = false;

  try {
    // 2. Load doctrine for stage filtering
    let intelligenceStageIds: Set<string> | null = null;
    try {
      const doctrine = await repos.getLatestDoctrine(companyId);
      if (doctrine?.doctrineJson) {
        const config = doctrine.doctrineJson as unknown as SalesDoctrineConfig;
        const stageLabels = config.stageLabels;
        const intelligenceStages = config.intelligenceStages ?? ["New", "Opportunity Validated"];
        if (stageLabels && Object.keys(stageLabels).length > 0) {
          intelligenceStageIds = new Set<string>();
          for (const [id, label] of Object.entries(stageLabels)) {
            if (intelligenceStages.includes(label)) {
              intelligenceStageIds.add(id);
            }
          }
        }
      }
    } catch {
      logger.warn("Could not load doctrine for stage filtering — processing all activities");
    }

    if (!intelligenceStageIds) {
      logger.warn("No stage labels configured — processing all activities");
    }

    // 3. Get unextracted activities
    const activities = await repos.listUnextractedActivities(companyId, batchSize);

    // Build deal-stage cache for stage filtering
    let dealStageMap: Map<string, string> | null = null;
    if (intelligenceStageIds) {
      const dealIds = [...new Set(activities.filter((a) => a.dealId).map((a) => a.dealId!))];
      dealStageMap = await repos.listDealsForStageCheck(companyId, dealIds);
    }

    // 3. Process each activity
    for (const activity of activities) {
      // Pre-attempt guard: retry budget exhausted
      if (activity.extractionAttempts >= MAX_EXTRACTION_ATTEMPTS) {
        await repos.transaction(async (tx) => {
          await tx.salesActivity.update({
            where: { id: activity.id },
            data: { extractedAt: new Date() }
          });
        });
        result.exhaustedItems++;
        result.warnings.push(
          `Activity ${activity.id} reached retry limit in a prior run. Marking exhausted.`
        );
        logger.warn({ activityId: activity.id, attempts: activity.extractionAttempts },
          "Activity reached retry limit in prior run — marking exhausted");
        continue;
      }

      // Defensive null-body guard (concurrent cleanup race)
      if (activity.body == null) {
        continue;
      }

      // Stage filtering: skip activities for deals outside intelligence scope
      if (intelligenceStageIds && activity.dealId && dealStageMap) {
        const dealStage = dealStageMap.get(activity.dealId);
        if (dealStage && !intelligenceStageIds.has(dealStage)) {
          await repos.transaction(async (tx) => {
            await tx.salesActivity.update({
              where: { id: activity.id },
              data: { extractedAt: new Date() }
            });
          });
          result.stageSkipped++;
          continue;
        }
      }

      // Structural skips
      if (activity.body.length < MIN_BODY_LENGTH) {
        await repos.transaction(async (tx) => {
          await tx.salesActivity.update({
            where: { id: activity.id },
            data: { extractedAt: new Date() }
          });
        });
        result.activitiesSkipped++;
        continue;
      }

      if (!activity.dealId) {
        await repos.transaction(async (tx) => {
          await tx.salesActivity.update({
            where: { id: activity.id },
            data: { extractedAt: new Date() }
          });
        });
        result.activitiesSkipped++;
        continue;
      }

      // PRE-LLM checkpoint
      const preLlmOk = await renewLeaseOrAbort(repos, runId);
      if (!preLlmOk) {
        leaseLost = true;
        logger.warn({ runId }, "Lease lost at pre-LLM checkpoint — aborting");
        break;
      }

      // Call LLM
      let llmOutput: ActivityExtractionOutput;
      let llmUsage: LlmUsage;
      try {
        const llmResult = await llmClient.generateStructured({
          step: "sales-extraction",
          system: EXTRACTION_SYSTEM_PROMPT,
          prompt: `Extract structured facts from this CRM activity:\n\n${activity.body.slice(0, MAX_BODY_FOR_LLM)}`,
          schema: activityExtractionSchema,
          provider,
          model,
          allowFallback: false,
          fallback: () => ({
            painPoints: [], blockers: [], nextStep: null, urgency: null,
            competitorMentions: [], budgetMentioned: false, budgetDetails: null,
            timelineMentioned: false, timelineDetails: null, championIdentified: null,
            decisionMakerMentioned: null, sentiment: "neutral" as const,
            requestedCapabilities: [], complianceConcerns: [],
          }),
        });
        llmOutput = llmResult.output;
        llmUsage = llmResult.usage;
      } catch (error) {
        // Classify error
        const errMsg = error instanceof Error ? error.message : String(error);
        const rateLimit = isRateLimitError(error);

        if (isRetryableError(error) || rateLimit) {
          // Increment attempts
          try {
            const newCount = await repos.incrementExtractionAttempts(activity.id);
            if (newCount >= MAX_EXTRACTION_ATTEMPTS) {
              // Escalate immediately
              await repos.transaction(async (tx) => {
                await tx.salesActivity.update({
                  where: { id: activity.id },
                  data: { extractedAt: new Date() }
                });
              });
              result.exhaustedItems++;
              result.warnings.push(
                `Activity ${activity.id} exhausted after ${newCount} attempts (last error: ${errMsg})`
              );
              logger.warn({ activityId: activity.id, attempts: newCount, error: errMsg },
                "Activity exhausted retry budget");
            } else {
              result.retryableErrors++;
              result.errors.push(`Retryable error on ${activity.id}: ${errMsg}`);
              logger.warn({ activityId: activity.id, attempts: newCount, error: errMsg },
                "Retryable extraction error");
            }
          } catch (incrementError) {
            // Increment itself failed — leave for retry, don't corrupt budget
            result.retryableErrors++;
            result.errors.push(`Retryable error on ${activity.id} (increment failed): ${errMsg}`);
            logger.error({ activityId: activity.id, error: errMsg, err: incrementError },
              "Extraction failed and attempt increment also failed");
          }

          if (rateLimit) {
            result.rateLimited = true;
            logger.warn("Rate limited — stopping batch early");
            break;
          }
          continue;
        }

        // Non-retryable unexpected error — treat as retryable to be safe
        result.retryableErrors++;
        result.errors.push(`Unexpected error on ${activity.id}: ${errMsg}`);
        logger.error({ activityId: activity.id, err: error }, "Unexpected extraction error");
        continue;
      }

      // PRE-WRITE checkpoint
      const preWriteOk = await renewLeaseOrAbort(repos, runId);
      if (!preWriteOk) {
        leaseLost = true;
        logger.warn({ runId }, "Lease lost at pre-write checkpoint — discarding LLM result");
        break;
      }

      // Fan out facts and write atomically
      const facts = fanOutFacts(companyId, activity.id, activity.dealId, llmOutput, activity.body);

      await repos.transaction(async (tx) => {
        // Delete old facts for this activity
        await repos.deleteFactsForActivity(activity.id, tx);

        // Insert new facts
        for (const fact of facts) {
          await tx.salesExtractedFact.upsert({
            where: { id: fact.id },
            create: fact,
            update: {}
          });
        }

        // Mark extracted
        await tx.salesActivity.update({
          where: { id: activity.id },
          data: { extractedAt: new Date() }
        });

        // Record cost
        if (llmUsage.promptTokens > 0 || llmUsage.completionTokens > 0) {
          const costId = createDeterministicId("cost", [runId, activity.id, Date.now().toString()]);
          await tx.costLedgerEntry.create({
            data: {
              id: costId,
              runId,
              step: "sales-extraction",
              model: model ?? "unknown",
              mode: llmUsage.mode,
              promptTokens: llmUsage.promptTokens,
              completionTokens: llmUsage.completionTokens,
              estimatedCostUsd: llmUsage.estimatedCostUsd
            }
          });
        }
      });

      result.activitiesProcessed++;
      result.factsCreated += facts.length;
      result.costUsd += llmUsage.estimatedCostUsd;

      if (facts.length === 0) {
        result.terminalSkips++;
      }

      // POST-ITEM checkpoint
      const postItemOk = await renewLeaseOrAbort(repos, runId);
      if (!postItemOk) {
        leaseLost = true;
        logger.warn({ runId }, "Lease lost at post-item checkpoint — stopping");
        break;
      }
    }

    // Finalize (only if we still own the lease)
    if (!leaseLost) {
      await repos.finalizeSyncRun(
        runId,
        "completed",
        {
          activitiesProcessed: result.activitiesProcessed,
          activitiesSkipped: result.activitiesSkipped,
          stageSkipped: result.stageSkipped,
          factsCreated: result.factsCreated,
          retryableErrors: result.retryableErrors,
          terminalSkips: result.terminalSkips,
          exhaustedItems: result.exhaustedItems,
        },
        result.warnings
      );
    }
  } catch (error) {
    if (!leaseLost) {
      try {
        await repos.finalizeSyncRun(runId, "failed", {}, [],
          error instanceof Error ? error.message : "Unknown error");
      } catch {
        // Best effort — if finalize fails, the lease will expire
      }
    }
    throw error;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Lease helper
// ---------------------------------------------------------------------------

async function renewLeaseOrAbort(repos: SalesRepositoryBundle, runId: string): Promise<boolean> {
  try {
    return await repos.renewLease(runId);
  } catch {
    return false;
  }
}
