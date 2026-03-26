-- CreateTable
CREATE TABLE "Whale" (
    "id" SERIAL NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Whale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhaleTx" (
    "id" SERIAL NOT NULL,
    "signature" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhaleTx_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Whale_address_key" ON "Whale"("address");

-- CreateIndex
CREATE UNIQUE INDEX "WhaleTx_signature_key" ON "WhaleTx"("signature");
