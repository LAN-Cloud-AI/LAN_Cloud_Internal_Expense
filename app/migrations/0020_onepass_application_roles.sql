-- The last signed application role assignment, scoped by the existing grant.
-- NULL denotes an account whose roles have yet to be imported into OnePass.
ALTER TABLE onepass_grants ADD COLUMN application_roles_json TEXT
  CHECK(application_roles_json IS NULL OR json_valid(application_roles_json));
