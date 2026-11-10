-- Send files: containers HyperProx never looks inside on a cluster (default none). Additive only.
ALTER TABLE "ManagedCluster" ADD COLUMN "ignoredGuests" TEXT[] DEFAULT ARRAY[]::TEXT[];
