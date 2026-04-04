/*
  Warnings:

  - Added the required column `signalReceivedAt` to the `ObserverTrade` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ObserverTrade" ADD COLUMN     "dbWrittenAt" BIGINT,
ADD COLUMN     "isLiquidityLocked" BOOLEAN,
ADD COLUMN     "signalReceivedAt" BIGINT NOT NULL;
