import { Router } from "express";
import { z } from "zod";
import { type PrismaClient } from "@prisma/client";
import { decisionSchema } from "@invoiceguard/contracts";
import { analyzeInvoice, analysisDto } from "../analysis/service.js";
import { analyzeWithGemini, type GeminiService } from "../analysis/gemini.js";
import { AppError } from "../lib/errors.js";
const uuid = z.string().uuid();
function authorize(role: string) {
  if (!["OWNER", "REVIEWER"].includes(role))
    throw new AppError(
      403,
      "FORBIDDEN",
      "Your role cannot analyze or review invoices.",
    );
}
export function reviewRouter(
  db: PrismaClient,
  gemini: GeminiService = analyzeWithGemini,
) {
  const router = Router();
  router.get("/invoices/:id", async (req, res) => {
    const invoice = await db.invoice.findFirst({
      where: {
        id: uuid.parse(req.params.id),
        organizationId: res.locals.session.membership.organizationId,
      },
      include: {
        vendor: { select: { id: true, name: true } },
        lineItems: { orderBy: { position: "asc" } },
      },
    });
    if (!invoice)
      throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    res.json({
      ...invoice,
      subtotal: invoice.subtotal.toFixed(2),
      tax: invoice.tax.toFixed(2),
      total: invoice.total.toFixed(2),
      lineItems: invoice.lineItems.map((l) => ({
        ...l,
        quantity: l.quantity.toString(),
        unitPrice: l.unitPrice.toFixed(2),
        amount: l.amount.toFixed(2),
      })),
    });
  });
  router.post("/invoices/:id/analyses", async (req, res) => {
    const s = res.locals.session;
    authorize(s.membership.role);
    res
      .status(201)
      .json(
        await analyzeInvoice(
          db,
          s.membership.organizationId,
          uuid.parse(req.params.id),
          s.userId,
          gemini,
        ),
      );
  });
  router.get("/invoices/:id/analyses", async (req, res) => {
    const id = uuid.parse(req.params.id),
      organizationId = res.locals.session.membership.organizationId;
    if (
      !(await db.invoice.findFirst({
        where: { id, organizationId },
        select: { id: true },
      }))
    )
      throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    const runs = await db.analysisRun.findMany({
      where: { invoiceId: id, invoice: { organizationId } },
      include: { anomalies: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    res.json(runs.map(analysisDto));
  });
  router.get("/analyses/:id", async (req, res) => {
    const run = await db.analysisRun.findFirst({
      where: {
        id: uuid.parse(req.params.id),
        invoice: {
          organizationId: res.locals.session.membership.organizationId,
        },
      },
      include: { anomalies: true },
    });
    if (!run)
      throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found.");
    res.json(analysisDto(run));
  });
  router.get("/invoices/:id/decisions", async (req, res) => {
    const id = uuid.parse(req.params.id),
      organizationId = res.locals.session.membership.organizationId;
    if (
      !(await db.invoice.findFirst({
        where: { id, organizationId },
        select: { id: true },
      }))
    )
      throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    res.json(
      await db.reviewDecision.findMany({
        where: { invoiceId: id, invoice: { organizationId } },
        include: { actor: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
  });
  // This is the sole human decision write path. Never called from the analysis service.
  router.post("/invoices/:id/decisions", async (req, res) => {
    const s = res.locals.session;
    authorize(s.membership.role);
    const id = uuid.parse(req.params.id),
      input = decisionSchema.parse(req.body),
      organizationId = s.membership.organizationId;
    const decision = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id}::uuid AND "organizationId" = ${organizationId}::uuid FOR UPDATE`;
      const invoice = await tx.invoice.findFirst({
        where: { id, organizationId },
      });
      if (!invoice)
        throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
      const last = await tx.reviewDecision.findFirst({
        where: { invoiceId: id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (
        invoice.revision !== input.invoiceRevision ||
        (last?.id ?? null) !== input.expectedLastDecisionId
      )
        throw new AppError(
          409,
          "STALE_REVIEW",
          "This invoice or its human decision changed. Refresh before submitting your decision.",
        );
      if (
        input.analysisRunId &&
        !(await tx.analysisRun.findFirst({
          where: {
            id: input.analysisRunId,
            invoiceId: id,
            invoiceRevision: invoice.revision,
            status: "COMPLETED",
          },
        }))
      )
        throw new AppError(
          409,
          "STALE_ANALYSIS",
          "Select a completed analysis for the current invoice revision, or review without AI.",
        );
      const saved = await tx.reviewDecision.create({
        data: {
          invoiceId: id,
          actorId: s.userId,
          decision: input.decision,
          // Keep history ordered even when concurrent transactions started before the row lock.
          createdAt: new Date(
            Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1),
          ),
          reason: input.reason,
          invoiceRevision: invoice.revision,
          analysisRunId: input.analysisRunId,
        },
        include: { actor: { select: { id: true, name: true } } },
      });
      await tx.invoice.update({
        where: { id },
        data: { reviewStatus: input.decision },
      });
      await tx.auditEvent.create({
        data: {
          organizationId,
          actorId: s.userId,
          action: "HUMAN_REVIEW_RECORDED",
          entityType: "ReviewDecision",
          entityId: saved.id,
          metadata: { invoiceId: id, decision: input.decision },
        },
      });
      return saved;
    });
    res.status(201).json(decision);
  });
  return router;
}
