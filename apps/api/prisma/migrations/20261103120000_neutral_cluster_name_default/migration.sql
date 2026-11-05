-- The init migration shipped a specific cluster's name as this column's default. An applied migration must
-- not be edited (Prisma records its checksum), so the default is changed here. Existing rows keep their name.
ALTER TABLE "ProxmoxCluster" ALTER COLUMN "name" SET DEFAULT 'Proxmox Cluster';
