-- Kept separate from enum creation because PostgreSQL requires newly added enum
-- values to be committed before they are referenced by data statements.
UPDATE "WhatsAppSession"
SET "status" = CASE "status"::text
  WHEN 'INITIALIZING' THEN 'STARTING'::"WhatsAppConnectionStatus"
  WHEN 'DISCONNECTED' THEN 'IDLE'::"WhatsAppConnectionStatus"
  WHEN 'AUTH_FAILURE' THEN 'ERROR'::"WhatsAppConnectionStatus"
  ELSE "status"
END;
