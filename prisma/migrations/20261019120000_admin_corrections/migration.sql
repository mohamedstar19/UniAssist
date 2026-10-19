-- DropForeignKey
ALTER TABLE "Correction" DROP CONSTRAINT "Correction_studentId_fkey";

-- AlterTable
ALTER TABLE "Correction" ADD COLUMN     "adminTelegramId" TEXT,
ALTER COLUMN "studentId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Correction" ADD CONSTRAINT "Correction_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

