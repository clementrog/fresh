import { describe, expect, it } from "vitest";
import { assessAngleSharpness } from "../src/lib/text.js";

describe("assessAngleSharpness", () => {
  describe("blocked angles (must fail sharpness)", () => {
    it("blocks topic label — short with no tension", () => {
      const result = assessAngleSharpness(
        "Payroll automation trends in French accounting firms",
        "Payroll automation"
      );
      expect(result.isSharp).toBe(false);
      expect(result.failedChecks).toContain("no stake — no tension, consequence, or position marker");
    });

    it("blocks generic subject framing — the importance of", () => {
      const result = assessAngleSharpness(
        "The importance of reliability in payroll software",
        "Reliability"
      );
      expect(result.isSharp).toBe(false);
      expect(result.failedChecks).toContain("generic subject framing");
    });

    it("blocks generic subject framing — trends in", () => {
      const result = assessAngleSharpness(
        "Trends in payroll digitization for French cabinets",
        "Payroll digitization"
      );
      expect(result.isSharp).toBe(false);
      expect(result.failedChecks).toContain("generic subject framing");
    });

    it("blocks question-only angle", () => {
      const result = assessAngleSharpness(
        "How do cabinets handle DSN complexity?",
        "DSN handling"
      );
      expect(result.isSharp).toBe(false);
      expect(result.failedChecks).toContain("question without a claim");
    });

    it("blocks no-stake angle — category label without tension markers", () => {
      const result = assessAngleSharpness(
        "Migration challenges for cabinets de paie",
        "Migration"
      );
      expect(result.isSharp).toBe(false);
      expect(result.failedChecks).toContain("no stake — no tension, consequence, or position marker");
    });

    it("blocks no-stake angle — vague learning reference", () => {
      const result = assessAngleSharpness(
        "What we learned from recent client conversations",
        "Client conversations"
      );
      expect(result.isSharp).toBe(false);
      // Starts with "what " and ends without "?" so notQuestionOnly passes,
      // but hasStake fails since no tension/consequence markers
    });

    it("blocks generic approach framing", () => {
      const result = assessAngleSharpness(
        "Linc's approach to payroll production",
        "Payroll production"
      );
      expect(result.isSharp).toBe(false);
      expect(result.failedChecks).toContain("no stake — no tension, consequence, or position marker");
    });

    it("blocks future/speculative angle", () => {
      const result = assessAngleSharpness(
        "The future of payroll automation",
        "Payroll automation"
      );
      expect(result.isSharp).toBe(false);
    });

    it("blocks technically true but editorially useless", () => {
      const result = assessAngleSharpness(
        "Payroll is complex and requires attention",
        "Payroll complexity"
      );
      expect(result.isSharp).toBe(false);
    });

    it("blocks French generic subject — les tendances", () => {
      const result = assessAngleSharpness(
        "Les tendances de la paie en France",
        "Paie en France"
      );
      expect(result.isSharp).toBe(false);
      expect(result.failedChecks).toContain("generic subject framing");
    });

    it("blocks angle that duplicates the title", () => {
      const result = assessAngleSharpness(
        "DSN regularization for cabinet payroll teams",
        "DSN regularization for cabinet payroll teams"
      );
      expect(result.isSharp).toBe(false);
      expect(result.failedChecks).toContain("angle duplicates source title");
    });

    it("blocks generic subject — exploring", () => {
      const result = assessAngleSharpness(
        "Exploring the relationship between payroll accuracy and client trust",
        "Payroll accuracy"
      );
      expect(result.isSharp).toBe(false);
      expect(result.failedChecks).toContain("generic subject framing");
    });
  });

  describe("passing angles (must not be blocked)", () => {
    it("passes angle with tension marker — because + proves (Path A)", () => {
      const result = assessAngleSharpness(
        "Cabinets run dual payroll for 3 months because no vendor proves parity upfront",
        "Migration friction"
      );
      expect(result.isSharp).toBe(true);
      expect(result.checks.hasStake).toBe(true);
    });

    it("passes angle with tension marker — cost + but + assume (Path A)", () => {
      const result = assessAngleSharpness(
        "DSN regularization failures cost cabinets 2-3h per cycle but most assume it's unavoidable",
        "DSN regularization"
      );
      expect(result.isSharp).toBe(true);
    });

    it("passes angle with contraction — n't + because (Path A)", () => {
      const result = assessAngleSharpness(
        "Mid-size cabinets don't migrate because of the 4-week freeze, not cost",
        "Migration blockers"
      );
      expect(result.isSharp).toBe(true);
    });

    it("passes angle via Path B — for the first time", () => {
      const result = assessAngleSharpness(
        "Clickable payslip gives cabinets proof of calculation logic for the first time",
        "Clickable payslip"
      );
      expect(result.isSharp).toBe(true);
      expect(result.checks.hasStake).toBe(true);
    });

    it("passes angle via Path B — eliminates", () => {
      const result = assessAngleSharpness(
        "Linc's DSN control eliminates regularization as a manual step",
        "DSN control"
      );
      expect(result.isSharp).toBe(true);
    });

    it("passes angle via Path B — demonstrates", () => {
      const result = assessAngleSharpness(
        "Convention HCR support demonstrates Linc's coverage of multi-branch payroll",
        "HCR convention"
      );
      expect(result.isSharp).toBe(true);
    });

    it("passes angle via Path C — number + domain terms + long enough", () => {
      const result = assessAngleSharpness(
        "3 of 5 cabinets cite calculation opacity as their top switching blocker for payroll migration",
        "Calculation opacity"
      );
      expect(result.isSharp).toBe(true);
      expect(result.checks.hasStake).toBe(true);
    });

    it("passes French angle with tension — malgré", () => {
      const result = assessAngleSharpness(
        "Les cabinets continuent la double paie malgré le coût opérationnel",
        "Double paie"
      );
      expect(result.isSharp).toBe(true);
    });

    it("passes French angle with tension — risque", () => {
      const result = assessAngleSharpness(
        "Le risque de perte des compteurs CP bloque la migration dans les cabinets",
        "Compteurs CP"
      );
      expect(result.isSharp).toBe(true);
    });

    it("passes angle with however", () => {
      const result = assessAngleSharpness(
        "Payroll vendors promise seamless migration however cabinet teams report weeks of parallel runs",
        "Payroll migration"
      );
      expect(result.isSharp).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("question without ? mark is not flagged as question-only", () => {
      const result = assessAngleSharpness(
        "Why cabinets assume regularization cost is unavoidable despite automation being available",
        "Regularization"
      );
      expect(result.checks.notQuestionOnly).toBe(true);
      // Still passes via Path A (assume, despite, cost)
      expect(result.isSharp).toBe(true);
    });

    it("very short angle with tension marker still passes", () => {
      const result = assessAngleSharpness(
        "Migration fails because of trust",
        "Migration"
      );
      // Short (5 tokens after stopwords) but has "fails" + "because" → passes hasStake
      expect(result.checks.hasStake).toBe(true);
      // notTopicLabel: <=5 tokens but hasStake is true → passes
      expect(result.checks.notTopicLabel).toBe(true);
      expect(result.isSharp).toBe(true);
    });

    it("empty angle fails all checks", () => {
      const result = assessAngleSharpness("", "Some title");
      expect(result.isSharp).toBe(false);
    });
  });
});
