-- AlterTable: add enabledModules to Organization with default ["hk"]
ALTER TABLE "Organization" ADD COLUMN "enabledModules" TEXT[] NOT NULL DEFAULT ARRAY['hk']::TEXT[];
