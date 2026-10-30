-- 今回の検証専用資料だけを削除します。vector拡張・volumeは残します。
\set ON_ERROR_STOP on

BEGIN;
DROP TABLE solveloop_infra_check.persistence_probe;
-- 想定外のオブジェクトがあればCASCADEせず、トランザクション全体を戻します。
DROP SCHEMA solveloop_infra_check;
COMMIT;
