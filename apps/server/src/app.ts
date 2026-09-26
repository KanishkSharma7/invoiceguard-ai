import { AppError } from "./lib/errors.js";
import { reviewRouter } from "./reviews/routes.js";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import argon2 from "argon2";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { z, ZodError } from "zod";
import {
  invoiceSchema,
  loginSchema,
  calculateSubtotal,
  normalizeInvoiceNumber,
  type CurrentUser,
} from "@invoiceguard/contracts";

export const prisma = new PrismaClient();
const config = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    APP_ORIGIN: z.string().url(),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
  })
  .parse(process.env);
export { config };
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const cookieOptions = {
  httpOnly: true,
  secure: config.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api",
};
const asyncAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.cookies?.session;
  if (typeof token !== "string")
    throw new AppError(401, "UNAUTHENTICATED", "Please sign in.");
  const session = await prisma.session.findUnique({
    where: { tokenHash: hash(token) },
    include: { user: true, membership: { include: { organization: true } } },
  });
  if (
    !session ||
    session.expiresAt <= new Date() ||
    session.membership.userId !== session.userId
  )
    throw new AppError(
      401,
      "UNAUTHENTICATED",
      "Your session has expired. Please sign in.",
    );
  res.locals.session = session;
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.get("x-csrf-token") !== session.csrfToken
  )
    throw new AppError(403, "CSRF_FAILED", "Refresh the page and try again.");
  next();
};
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.locals.requestId = randomUUID();
  res.setHeader("X-Request-Id", res.locals.requestId);
  next();
});
app.use(helmet());
app.use(express.json({ limit: "128kb" }));
app.use(cookieParser());
app.use("/api", (req, _res, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.get("origin") !== config.APP_ORIGIN
  )
    throw new AppError(
      403,
      "ORIGIN_REJECTED",
      "Request origin is not allowed.",
    );
  next();
});
app.get("/api/health/live", (_req, res) => {
  res.json({ status: "ok" });
});
app.get("/api/health/ready", async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ status: "ok" });
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(
      new AppError(
        429,
        "RATE_LIMITED",
        "Too many login attempts. Try again later.",
      ),
    ),
});
app.post("/api/v1/auth/login", authLimiter, async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { memberships: { orderBy: { id: "asc" }, take: 1 } },
  });
  // Always perform an expensive hash operation to reduce account enumeration via timing.
  const valid = user
    ? await argon2.verify(user.passwordHash, input.password)
    : (await argon2.hash(input.password), false);
  if (!user || !valid || !user.memberships[0])
    throw new AppError(
      401,
      "INVALID_CREDENTIALS",
      "Email or password is incorrect.",
    );
  const token = randomBytes(32).toString("hex");
  const membership = user.memberships[0];
  await prisma.$transaction(async (tx) => {
    if (typeof req.cookies.session === "string")
      await tx.session.deleteMany({
        where: { tokenHash: hash(req.cookies.session) },
      });
    await tx.session.create({
      data: {
        tokenHash: hash(token),
        csrfToken: randomBytes(32).toString("hex"),
        userId: user.id,
        membershipId: membership.id,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      },
    });
    await tx.auditEvent.create({
      data: {
        organizationId: membership.organizationId,
        actorId: user.id,
        action: "LOGIN",
        entityType: "User",
        entityId: user.id,
      },
    });
  });
  res
    .cookie("session", token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 })
    .json({ ok: true });
});
app.use("/api/v1", asyncAuth);
app.get("/api/v1/auth/me", (_req, res) => {
  const { user, membership, csrfToken } = res.locals.session;
  const dto: CurrentUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    organization: {
      id: membership.organization.id,
      name: membership.organization.name,
    },
    role: membership.role,
    csrfToken,
  };
  res.json(dto);
});
app.post("/api/v1/auth/logout", async (_req, res) => {
  const s = res.locals.session;
  await prisma.$transaction([
    prisma.session.delete({ where: { id: s.id } }),
    prisma.auditEvent.create({
      data: {
        organizationId: s.membership.organizationId,
        actorId: s.userId,
        action: "LOGOUT",
        entityType: "User",
        entityId: s.userId,
      },
    }),
  ]);
  res.clearCookie("session", cookieOptions).status(204).end();
});
app.get("/api/v1/vendors", async (_req, res) => {
  res.json(
    await prisma.vendor.findMany({
      where: { organizationId: res.locals.session.membership.organizationId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  );
});
app.get("/api/v1/dashboard/summary", async (_req, res) => {
  const where = {
    organizationId: res.locals.session.membership.organizationId,
  };
  const [invoiceCount, pendingCount, vendorCount] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.count({ where: { ...where, reviewStatus: "PENDING" } }),
    prisma.vendor.count({ where }),
  ]);
  res.json({ invoiceCount, pendingCount, vendorCount });
});
const dto = (
  invoice: Prisma.InvoiceGetPayload<{
    include: { vendor: { select: { id: true; name: true } } };
  }>,
) => ({
  ...invoice,
  subtotal: invoice.subtotal.toFixed(2),
  tax: invoice.tax.toFixed(2),
  total: invoice.total.toFixed(2),
});
app.get("/api/v1/invoices", async (req, res) => {
  const { page } = z
    .object({ page: z.coerce.number().int().min(1).max(100000).default(1) })
    .parse(req.query);
  const where = {
    organizationId: res.locals.session.membership.organizationId,
  };
  const [items, total] = await prisma.$transaction([
    prisma.invoice.findMany({
      where,
      include: { vendor: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * 20,
      take: 20,
    }),
    prisma.invoice.count({ where }),
  ]);
  res.json({ items: items.map(dto), total, page, pageSize: 20 });
});
app.post("/api/v1/invoices", async (req, res) => {
  const s = res.locals.session;
  if (!["OWNER", "REVIEWER"].includes(s.membership.role))
    throw new AppError(403, "FORBIDDEN", "Your role cannot create invoices.");
  const input = invoiceSchema.parse(req.body);
  const organizationId = s.membership.organizationId;
  const invoice = await prisma.$transaction(async (tx) => {
    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, organizationId },
    });
    if (!vendor)
      throw new AppError(404, "VENDOR_NOT_FOUND", "Vendor not found.");
    // Serialize same-vendor creation so simultaneous duplicate entries are detected.
    await tx.$queryRaw`SELECT id FROM "Vendor" WHERE id = ${vendor.id}::uuid FOR UPDATE`;
    const normalizedNumber = normalizeInvoiceNumber(input.invoiceNumber);
    const duplicate = await tx.invoice.findFirst({
      where: { organizationId, vendorId: vendor.id, normalizedNumber },
    });
    const saved = await tx.invoice.create({
      data: {
        organizationId,
        vendorId: vendor.id,
        invoiceNumber: input.invoiceNumber,
        normalizedNumber,
        issueDate: new Date(input.issueDate),
        dueDate: new Date(input.dueDate),
        currency: input.currency,
        subtotal: calculateSubtotal(input.lineItems),
        tax: input.tax,
        total: input.total,
        duplicateWarning: !!duplicate,
        lineItems: {
          create: input.lineItems.map((item, position) => ({
            ...item,
            position,
            amount: new Prisma.Decimal(item.quantity)
              .times(item.unitPrice)
              .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
          })),
        },
      },
      include: { vendor: { select: { id: true, name: true } } },
    });
    await tx.auditEvent.create({
      data: {
        organizationId,
        actorId: s.userId,
        action: "INVOICE_CREATED",
        entityType: "Invoice",
        entityId: saved.id,
        metadata: { duplicateWarning: !!duplicate },
      },
    });
    return saved;
  });
  res.status(201).json(dto(invoice));
});
app.use("/api/v1", reviewRouter(prisma));
app.use((_req, _res, next) =>
  next(new AppError(404, "NOT_FOUND", "Route not found.")),
);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  let status = 500,
    code = "INTERNAL_ERROR",
    message = "An unexpected error occurred. Please try again.",
    details: unknown;
  if (error instanceof ZodError) {
    status = 400;
    code = "VALIDATION_FAILED";
    message = "Check the submitted fields.";
    details = error.flatten();
  } else if (error instanceof AppError) {
    status = error.status;
    code = error.code;
    message = error.message;
  } else if (error instanceof SyntaxError && "body" in error) {
    status = 400;
    code = "INVALID_JSON";
    message = "Request body must be valid JSON.";
  } else if (
    typeof error === "object" &&
    error &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "Request is too large.";
  }
  if (status === 500)
    console.error(
      JSON.stringify({
        requestId: res.locals.requestId,
        event: "request_failed",
        errorType: error instanceof Error ? error.name : "Unknown",
      }),
    );
  res.status(status).json({
    error: { code, message, requestId: res.locals.requestId, details },
  });
});
export default app;
