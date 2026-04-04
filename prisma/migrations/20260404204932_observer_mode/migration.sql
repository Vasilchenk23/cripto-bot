/*
  Warnings:

  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `VirtualTrade` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "VirtualTrade" DROP CONSTRAINT "VirtualTrade_userId_fkey";

-- DropTable
DROP TABLE "User";

-- DropTable
DROP TABLE "VirtualTrade";

-- CreateTable
CREATE TABLE "ObserverTrade" (
    "id" SERIAL NOT NULL,
    "whaleId" INTEGER NOT NULL,
    "tokenSymbol" TEXT,
    "mintAddress" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "usdAmount" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "peak1m" DOUBLE PRECISION,
    "peak3m" DOUBLE PRECISION,
    "peak5m" DOUBLE PRECISION,
    "peak10m" DOUBLE PRECISION,
    "peak30m" DOUBLE PRECISION,

    CONSTRAINT "ObserverTrade_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ObserverTrade" ADD CONSTRAINT "ObserverTrade_whaleId_fkey" FOREIGN KEY ("whaleId") REFERENCES "Whale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
