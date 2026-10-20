-- Fork (access identity mode, docs/fork-access-identity.md): an access-proxy
-- subject links to one account, and an account to one subject. Overlapping
-- first sign-ins are settled by these indexes rather than by a held lock: the
-- request that loses an insert removes the user it just created and resolves
-- again, which finds the winner's link or refuses a second subject.
-- Partial, so other providers' rows are untouched, and kept out of
-- schema.prisma so the fork does not edit an upstream file. `prisma migrate
-- dev` will report them as drift; that is expected for these fork-owned indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "account_access_identity_subject_key"
  ON "account" ("providerId", "accountId")
  WHERE "providerId" = 'access-identity';

CREATE UNIQUE INDEX IF NOT EXISTS "account_access_identity_user_key"
  ON "account" ("userId")
  WHERE "providerId" = 'access-identity';
