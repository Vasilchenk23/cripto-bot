/*
  Warnings:

  - You are about to drop the column `createdAt` on the `Whale` table. All the data in the column will be lost.
  - You are about to drop the `Airdrop` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Note` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ObserverTrade` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WhaleTx` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ObserverTrade" DROP CONSTRAINT "ObserverTrade_whaleId_fkey";

-- DropForeignKey
ALTER TABLE "WhaleTx" DROP CONSTRAINT "WhaleTx_whaleId_fkey";

-- AlterTable
ALTER TABLE "Whale" DROP COLUMN "createdAt";

-- DropTable
DROP TABLE "Airdrop";

-- DropTable
DROP TABLE "Note";

-- DropTable
DROP TABLE "ObserverTrade";

-- DropTable
DROP TABLE "WhaleTx";

-- CreateTable
CREATE TABLE "Account" (
    "id" INTEGER NOT NULL DEFAULT 0,
    "virtualBalance" DOUBLE PRECISION NOT NULL DEFAULT 100.0,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" SERIAL NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "side" TEXT NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "isBot" BOOLEAN NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "whaleId" INTEGER,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_whaleId_fkey" FOREIGN KEY ("whaleId") REFERENCES "Whale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
