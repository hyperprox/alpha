-- CreateTable
CREATE TABLE "ManagedCertificate" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "names" TEXT[],
    "status" TEXT NOT NULL,
    "issuer" TEXT,
    "serial" TEXT,
    "fingerprint" TEXT,
    "notBefore" TIMESTAMP(3),
    "notAfter" TIMESTAMP(3),
    "ariStart" TIMESTAMP(3),
    "ariEnd" TIMESTAMP(3),
    "renewAfter" TIMESTAMP(3),
    "staging" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "issuedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertTarget" (
    "id" TEXT NOT NULL,
    "certId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lastDeployAt" TIMESTAMP(3),
    "ok" BOOLEAN,
    "detail" TEXT,
    "fingerprint" TEXT,

    CONSTRAINT "CertTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertProbe" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "starttls" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" TIMESTAMP(3),
    "verdict" TEXT,
    "reason" TEXT,
    "fingerprint" TEXT,
    "issuer" TEXT,
    "notAfter" TIMESTAMP(3),
    "trusted" BOOLEAN,
    "namesMatch" BOOLEAN,

    CONSTRAINT "CertProbe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertEvent" (
    "id" TEXT NOT NULL,
    "certId" TEXT,
    "label" TEXT,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "detail" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertState" (
    "id" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagedCertificate_label_key" ON "ManagedCertificate"("label");

-- CreateIndex
CREATE UNIQUE INDEX "CertTarget_certId_name_key" ON "CertTarget"("certId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CertProbe_host_port_key" ON "CertProbe"("host", "port");

-- CreateIndex
CREATE INDEX "CertEvent_at_idx" ON "CertEvent"("at");

-- CreateIndex
CREATE INDEX "CertEvent_label_at_idx" ON "CertEvent"("label", "at");

-- AddForeignKey
ALTER TABLE "CertTarget" ADD CONSTRAINT "CertTarget_certId_fkey" FOREIGN KEY ("certId") REFERENCES "ManagedCertificate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CertEvent" ADD CONSTRAINT "CertEvent_certId_fkey" FOREIGN KEY ("certId") REFERENCES "ManagedCertificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

