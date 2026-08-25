-- Additive enum migration: old enum labels remain in PostgreSQL so existing rows
-- can be mapped by the application before a later, separately scheduled cleanup.
ALTER TYPE "WhatsAppConnectionStatus" ADD VALUE IF NOT EXISTS 'IDLE';
ALTER TYPE "WhatsAppConnectionStatus" ADD VALUE IF NOT EXISTS 'STARTING';
ALTER TYPE "WhatsAppConnectionStatus" ADD VALUE IF NOT EXISTS 'DISCONNECTING';
ALTER TYPE "WhatsAppConnectionStatus" ADD VALUE IF NOT EXISTS 'LOGGING_OUT';
