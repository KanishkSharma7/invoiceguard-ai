import { Prisma, type PrismaClient } from "@prisma/client";
import {
  aiOutputSchema,
  type AnalysisDto,
  type Finding,
} from "@invoiceguard/contracts";
import { runChecks, RULE_VERSION, type InvoiceSnapshot } from "./checks.js";
import {
  analyzeWithGemini,
  DEFAULT_MODEL,
  PROMPT_VERSION,
  type GeminiService,
} from "./gemini.js";
import { AppError } from "../lib/errors.js";
export type StoredInvoice = Prisma.InvoiceGetPayload<{
  include: { lineItems: true };
}>;
export function snapshot(invoice: StoredInvoice): InvoiceSnapshot {
  return {
    id: invoice.id,
    organizationId: invoice.organizationId,
    vendorId: invoice.vendorId,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate.toISOString(),
    dueDate: invoice.dueDate.toISOString(),
    currency: invoice.currency,
    subtotal: invoice.subtotal.toString(),
    tax: invoice.tax.toString(),
    total: invoice.total.toString(),
    reviewStatus: invoice.reviewStatus,
    lineItems: invoice.lineItems.map((l) => ({
      id: l.id,
      description: l.description,
      quantity: l.quantity.toString(),
      unitPrice: l.unitPrice.toString(),
      amount: l.amount.toString(),
    })),
  };
}
type StoredAnalysis = Prisma.AnalysisRunGetPayload<{
  include: { anomalies: true };
}>;
export function analysisDto(run: StoredAnalysis): AnalysisDto {
  const evidence = run.evidence as { limitations?: string[] } | null;
  const map = (source: string) =>
    run.anomalies
      .filter((a) => a.source === source)
      .map((a) => {
        const data = a.evidence as {
          items: Finding["evidence"];
          whyItMatters: string;
        };
        return {
          type: a.type,
          severity: a.severity as Finding["severity"],
          explanation: a.explanation,
          evidence: data.items,
          whyItMatters: data.whyItMatters,
        };
      });
  return {
    id: run.id,
    invoiceId: run.invoiceId,
    invoiceRevision: run.invoiceRevision,
    status: run.status,
    riskLevel: run.riskLevel as AnalysisDto["riskLevel"],
    confidence:
      run.confidence === null ? null : run.confidence.times(100).toNumber(),
    summary: run.summary,
    recommendation: run.recommendation as AnalysisDto["recommendation"],
    reviewerActions: (run.reviewerActions as string[] | null) ?? [],
    insufficientHistory: run.insufficientHistory,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    modelVersion: run.modelVersion,
    promptVersion: run.promptVersion,
    failureCode: run.failureCode,
    deterministicFindings: map("DETERMINISTIC"),
    aiFindings: map("AI"),
    limitations: evidence?.limitations ?? [],
  };
}
const findingData = (finding: Finding, source: string) => ({
  source,
  type: finding.type,
  severity: finding.severity,
  explanation: finding.explanation,
  evidence: { items: finding.evidence, whyItMatters: finding.whyItMatters },
});
const active = new Set<string>();
// Only this service writes analysis records. It contains no invoice update or ReviewDecision write.
export async function analyzeInvoice(
  db: PrismaClient,
  organizationId: string,
  invoiceId: string,
  actorId: string,
  gemini: GeminiService = analyzeWithGemini,
): Promise<AnalysisDto> {
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    include: { lineItems: { orderBy: { position: "asc" } } },
  });
  if (!invoice)
    throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
  if (active.has(invoiceId))
    throw new AppError(
      409,
      "ANALYSIS_IN_PROGRESS",
      "This invoice is already being analyzed. Wait for that request to finish.",
    );
  active.add(invoiceId);
  try {
    const [prior, duplicates] = await Promise.all([
      db.invoice.findMany({
        where: {
          organizationId,
          vendorId: invoice.vendorId,
          id: { not: invoiceId },
          issueDate: { lt: invoice.issueDate },
          currency: invoice.currency,
          reviewStatus: { not: "REJECTED" },
        },
        include: { lineItems: { orderBy: { position: "asc" } } },
        orderBy: [{ issueDate: "desc" }, { id: "desc" }],
        take: 100,
      }),
      db.invoice.findMany({
        where: {
          organizationId,
          vendorId: invoice.vendorId,
          id: { not: invoiceId },
          normalizedNumber: invoice.normalizedNumber,
        },
        include: { lineItems: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);
    const current = snapshot(invoice),
      checks = runChecks(
        current,
        prior.map(snapshot),
        duplicates.map(snapshot),
      );
    const { history, ...deterministic } = checks;
    const evidence = {
      ruleVersion: RULE_VERSION,
      limitations: checks.limitations,
      current,
      historyIds: history.map((i) => i.id),
      historySnapshot: history,
    };
    const run = await db.analysisRun.create({
      data: {
        invoiceId,
        invoiceRevision: invoice.revision,
        promptVersion: PROMPT_VERSION,
        modelVersion: process.env.GEMINI_MODEL || DEFAULT_MODEL,
        insufficientHistory: checks.insufficientHistory,
        evidence,
        anomalies: {
          create: checks.findings.map((f) => findingData(f, "DETERMINISTIC")),
        },
      },
    });
    try {
      const result = await gemini({ current, deterministic, history });
      // Validate again at the persistence boundary, including injected test/provider implementations.
      const validated = aiOutputSchema.safeParse(result.output);
      if (!validated.success)
        throw new AppError(
          502,
          "GEMINI_INVALID_RESPONSE",
          "Gemini returned invalid review data. Retry analysis.",
        );
      const output = validated.data;
      const insufficientHistory =
        checks.insufficientHistory || output.insufficientHistory;
      const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
      const riskLevel = checks.findings.reduce(
        (risk, f) => (rank[f.severity] > rank[risk] ? f.severity : risk),
        output.riskLevel,
      );
      const saved = await db.$transaction(async (tx) => {
        const completed = await tx.analysisRun.update({
          where: { id: run.id },
          data: {
            status: "COMPLETED",
            riskLevel,
            confidence: new Prisma.Decimal(
              insufficientHistory
                ? Math.min(output.confidence, 60)
                : output.confidence,
            ).div(100),
            summary: output.executiveSummary,
            recommendation: output.recommendation,
            reviewerActions: output.recommendedReviewerActions,
            insufficientHistory,
            modelVersion: result.modelVersion,
            completedAt: new Date(),
            evidence: { ...evidence, aiOutput: output },
            anomalies: {
              create: output.contextualAnomalies.map((f) =>
                findingData(f, "AI"),
              ),
            },
          },
          include: { anomalies: true },
        });
        await tx.auditEvent.create({
          data: {
            organizationId,
            actorId,
            action: "ANALYSIS_COMPLETED",
            entityType: "AnalysisRun",
            entityId: run.id,
            metadata: { invoiceId },
          },
        });
        return completed;
      });
      return analysisDto(saved);
    } catch (error) {
      const safe =
        error instanceof AppError
          ? error
          : new AppError(
              502,
              "ANALYSIS_FAILED",
              "Analysis could not be completed. Retry shortly.",
            );
      await db.$transaction([
        db.analysisRun.update({
          where: { id: run.id },
          data: {
            status: "FAILED",
            failureCode: safe.code,
            completedAt: new Date(),
          },
        }),
        db.auditEvent.create({
          data: {
            organizationId,
            actorId,
            action: "ANALYSIS_FAILED",
            entityType: "AnalysisRun",
            entityId: run.id,
            metadata: { invoiceId, code: safe.code },
          },
        }),
      ]);
      throw safe;
    }
  } finally {
    active.delete(invoiceId);
  }
}
