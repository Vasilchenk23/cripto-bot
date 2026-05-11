ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "signature" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Trade_signature_key" ON "Trade"("signature");
