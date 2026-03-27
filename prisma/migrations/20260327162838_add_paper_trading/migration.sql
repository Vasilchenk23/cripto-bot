-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "telegramId" TEXT NOT NULL,
    "virtualBalance" DOUBLE PRECISION NOT NULL DEFAULT 2000.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VirtualTrade" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "symbol" TEXT,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "amountUAH" DOUBLE PRECISION NOT NULL DEFAULT 500.0,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "exitPrice" DOUBLE PRECISION,
    "pnlUAH" DOUBLE PRECISION,
    "pnlPercent" DOUBLE PRECISION,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "VirtualTrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- AddForeignKey
ALTER TABLE "VirtualTrade" ADD CONSTRAINT "VirtualTrade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
