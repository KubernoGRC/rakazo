-- Fork (access identity mode, docs/fork-access-identity.md): one account link
-- per access-proxy subject. Overlapping first sign-ins for one subject are
-- settled here rather than by a held lock; the request that loses the insert
-- removes the user it just created and resolves to the winner's link.
-- Partial, so other providers' rows are untouched, and kept out of
-- schema.prisma so the fork does not edit an upstream file. `prisma migrate
-- dev` will report it as drift; that is expected for this fork-owned index.
CREATE UNIQUE INDEX IF NOT EXISTS "account_access_identity_subject_key"
  ON "account" ("providerId", "accountId")
  WHERE "providerId" = 'access-identity';
