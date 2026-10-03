-- DropForeignKey
ALTER TABLE "login_attempts" DROP CONSTRAINT "login_attempts_userId_fkey";

-- DropIndex
DROP INDEX "login_attempts_userId_key";

-- DropIndex
DROP INDEX "users_resetToken_key";

-- DropIndex
DROP INDEX "users_verifyToken_key";

-- AlterTable
ALTER TABLE "login_attempts" DROP COLUMN "userId";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "passwordSalt",
DROP COLUMN "resetToken",
DROP COLUMN "verifyToken",
ADD COLUMN     "resetTokenHash" TEXT,
ADD COLUMN     "verifyTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_verifyTokenHash_key" ON "users"("verifyTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "users_resetTokenHash_key" ON "users"("resetTokenHash");
