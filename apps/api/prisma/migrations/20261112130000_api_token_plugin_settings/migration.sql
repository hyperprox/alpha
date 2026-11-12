-- API tokens: an opt-in, owner-granted permission to save plug-in settings without the master password.
-- Additive only. Every existing token keeps it off.
ALTER TABLE "ApiToken"
  ADD COLUMN "pluginSettingsWithoutReconfirm" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pluginSettingsGrantedBy" TEXT,
  ADD COLUMN "pluginSettingsGrantedAt" TIMESTAMP(3);
