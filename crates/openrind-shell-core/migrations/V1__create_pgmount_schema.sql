CREATE SCHEMA IF NOT EXISTS _openrind;

CREATE TABLE IF NOT EXISTS _openrind.schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);
