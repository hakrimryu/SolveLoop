\set ON_ERROR_STOP on
DO $$
BEGIN
    IF current_database() <> 'solveloop_demo' OR current_user <> 'solveloop_demo' THEN
        RAISE EXCEPTION 'デモ専用のDBとロールが必要です。';
    END IF;
END $$;
CREATE SCHEMA demo_guard;
REVOKE ALL ON SCHEMA demo_guard FROM PUBLIC;
CREATE TABLE demo_guard.identity (
    singleton boolean PRIMARY KEY CHECK (singleton),
    instance_id uuid NOT NULL,
    system_identifier text NOT NULL,
    database_oid oid NOT NULL
);
INSERT INTO demo_guard.identity
SELECT true, 'ef53d43d-57f8-43b7-8230-31983ef3f020',
       system_identifier::text,
       (SELECT oid FROM pg_database WHERE datname = current_database())
FROM pg_control_system();
CREATE TABLE demo_guard.seed_receipt (
    singleton boolean PRIMARY KEY CHECK (singleton),
    seed_version text NOT NULL,
    manifest_hash text NOT NULL,
    baseline_hash text NOT NULL,
    loaded_at timestamptz NOT NULL DEFAULT now()
);
