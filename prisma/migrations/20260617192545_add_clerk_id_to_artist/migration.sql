/*
  Warnings:

  - You are about to drop the column `passwordHash` on the `Artist` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[clerkId]` on the table `Artist` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `clerkId` to the `Artist` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Artist" DROP COLUMN "passwordHash",
ADD COLUMN     "clerkId" TEXT NOT NULL,
ALTER COLUMN "handle" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Artist_clerkId_key" ON "Artist"("clerkId");
