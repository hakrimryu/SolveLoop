-- インフラ検証専用です。業務テーブル・シード・マイグレーションではありません。
\set ON_ERROR_STOP on

BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
-- 同名の既存資料があれば停止し、上書きしません。
CREATE SCHEMA solveloop_infra_check;
CREATE TABLE solveloop_infra_check.persistence_probe (
  id integer PRIMARY KEY,
  marker text NOT NULL,
  embedding vector(3) NOT NULL
);
INSERT INTO solveloop_infra_check.persistence_probe (id, marker, embedding)
VALUES (1, 'solveloop-volume-probe', '[1,2,3]');
COMMIT;
