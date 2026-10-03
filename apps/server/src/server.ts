import app, { config, prisma } from "./app.js";
try {
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
} catch {
  console.error("Database startup connection failed");
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}
const server = app.listen(config.PORT, "0.0.0.0", () =>
  console.log(`InvoiceGuard listening on port ${config.PORT}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
