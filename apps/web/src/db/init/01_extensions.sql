-- Postgres extensions required by the LLteacher schema.
--
-- Canonical manifest of "what extensions does this schema need." Apply
-- once against whichever Postgres instance the migrations will target,
-- before running drizzle migrations:
--
--   psql "$DATABASE_URL" -f apps/web/src/db/init/01_extensions.sql
--
-- Targets:
--   - Personal Neon dev branch (free tier)  -- local development
--   - GitHub Actions Postgres service       -- CI (.github/workflows/test.yml)
--   - UW-issued Neon project                -- staging / prod (when access lands)

CREATE EXTENSION IF NOT EXISTS vector;
