-- AlterTable
ALTER TABLE "WhaleTx" ADD COLUMN     "whaleId" INTEGER;

-- AddForeignKey
ALTER TABLE "WhaleTx" ADD CONSTRAINT "WhaleTx_whaleId_fkey" FOREIGN KEY ("whaleId") REFERENCES "Whale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
