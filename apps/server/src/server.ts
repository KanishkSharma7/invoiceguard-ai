import app, { config, prisma } from "./app.js";
await prisma.$connect();
const server = app.listen(config.PORT, "127.0.0.1", () =>
  console.log(`InvoiceGuard API listening on http://127.0.0.1:${config.PORT}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
