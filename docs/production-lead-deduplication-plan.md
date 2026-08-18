# Production lead deduplication plan

No destructive cleanup or unique index is applied automatically. Existing lead history must be audited before enforcing one current qualified lead per contact.

## Audit

```sql
SELECT "contactId", COUNT(*) AS lead_count, ARRAY_AGG(id ORDER BY "createdAt") AS lead_ids
FROM "Lead"
GROUP BY "contactId"
HAVING COUNT(*) > 1;
```

For every duplicate group, export the related conversations, messages, campaign targets and manager comments. Choose the canonical lead with the latest meaningful manager activity; preserve the other rows as history rather than deleting them.

## Safe cleanup

1. Stop automation workers and take a database backup.
2. Repoint any external references to the canonical lead.
3. Mark historical duplicates `CLOSED` and record the canonical lead id in an audit export.
4. Verify that no contact has more than one lead in `NEW`, `QUALIFIED` or `TRANSFERRED`.
5. Only then add the partial unique index:

```sql
CREATE UNIQUE INDEX CONCURRENTLY "Lead_one_current_per_contact"
ON "Lead" ("contactId")
WHERE status IN ('NEW', 'QUALIFIED', 'TRANSFERRED');
```

`CREATE INDEX CONCURRENTLY` must be run outside a Prisma migration transaction. Deploy the runtime contact-level guard first, perform cleanup, then apply the index as a separately approved production operation.
