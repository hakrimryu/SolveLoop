-- 今回の検証専用資料だけを削除します。vector拡張・volumeは残します。
-- [ko] 이번 검증 전용 자료만 삭제하며 vector 확장과 volume은 남긴다.
-- [en] Remove only the probe records; preserve the vector extension and volume.
\set ON_ERROR_STOP on

BEGIN;
DROP TABLE solveloop_infra_check.persistence_probe;
-- 想定外のオブジェクトがあればCASCADEせず、トランザクション全体を戻します。
-- [ko] 예상 밖의 객체가 있으면 CASCADE하지 않고 트랜잭션 전체를 되돌린다.
-- [en] Roll back if unexpected objects exist instead of cascading into unrelated data.
DROP SCHEMA solveloop_infra_check;
COMMIT;
