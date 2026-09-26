ALTER TABLE "AnalysisRun"
ADD COLUMN "riskLevel" TEXT,
ADD COLUMN "summary" TEXT,
ADD COLUMN "recommendation" TEXT,
ADD COLUMN "reviewerActions" JSONB,
ADD COLUMN "insufficientHistory" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "completedAt" TIMESTAMP(3),
ADD COLUMN "failureCode" TEXT;
ALTER TABLE "Anomaly" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'DETERMINISTIC';
