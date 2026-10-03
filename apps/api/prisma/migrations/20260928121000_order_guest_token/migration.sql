-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "guestToken" TEXT;

-- CreateIndex
CREATE INDEX "orders_guestToken_idx" ON "orders"("guestToken");
