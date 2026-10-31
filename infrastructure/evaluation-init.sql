\set ON_ERROR_STOP on
DO $$
BEGIN
    IF current_database() <> 'solveloop_evaluation' OR current_user <> 'solveloop_evaluation' THEN
        RAISE EXCEPTION '評価専用DB以外は使用できません。';
    END IF;
END $$;
CREATE SCHEMA evaluation_guard;
REVOKE ALL ON SCHEMA evaluation_guard FROM PUBLIC;
CREATE TABLE evaluation_guard.identity AS
SELECT 's21-v1'::text AS instance, system_identifier::text AS cluster,
       (SELECT oid FROM pg_database WHERE datname = current_database()) AS database_oid
FROM pg_control_system();
