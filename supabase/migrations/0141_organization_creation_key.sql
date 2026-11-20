-- 0141: a creation key on organizations, so that creating a client workspace is idempotent.
-- The key is chosen by the server (for a purchase it is 'purchase:' plus the purchase intent's id), never by a browser or a buyer, and holds no secret.
-- The application role already reads organizations table-wide (0001) and can update only the columns it was granted there, so no grant changes:
-- creation_key is readable under the existing row-level policy and writable only by the server's system connection.

alter table organizations
  add column creation_key text check (creation_key is null or char_length(creation_key) between 8 and 160);

create unique index organizations_creation_key_unique on organizations (creation_key) where creation_key is not null;

comment on column organizations.creation_key is 'Server-chosen idempotency key of the request that created this workspace. A second creation with the same key returns this workspace instead of making another. Null for workspaces made before 0141 or without a key.';
