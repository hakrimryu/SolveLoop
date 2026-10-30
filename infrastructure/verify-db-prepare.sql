-- インフラ検証専用です。業務テーブル・シード・マイグレーションではありません。
-- [ko] 인프라 검증 전용이며 업무 테이블·시드·마이그레이션이 아니다.
-- [en] This probe is for infrastructure verification, not business data, seeds, or migrations.
\set ON_ERROR_STOP on

BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
-- 同名の既存資料があれば停止し、上書きしません。
-- [ko] 같은 이름의 자료가 이미 있으면 중단하고 덮어쓰지 않는다.
-- [en] Stop if the probe schema already exists rather than overwrite existing records.
CREATE SCHEMA solveloop_infra_check;
CREATE TABLE solveloop_infra_check.persistence_probe (
  id integer PRIMARY KEY,
  marker text NOT NULL,
  embedding vector(3) NOT NULL
);
INSERT INTO solveloop_infra_check.persistence_probe (id, marker, embedding)
VALUES (1, 'solveloop-volume-probe', '[1,2,3]');
COMMIT;
