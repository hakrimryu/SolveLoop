-- 再起動・再作成の前後で同じ保存行とベクトル演算を確認します。
-- [ko] 재시작·재생성 전후에 같은 저장 행과 벡터 연산을 확인한다.
-- [en] Check the same stored row and vector calculation before and after container recreation.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'PostgreSQL 17ではありません';
  END IF;
  IF (SELECT extversion FROM pg_extension WHERE extname = 'vector') IS DISTINCT FROM '0.8.7' THEN
    RAISE EXCEPTION 'pgvector 0.8.7ではありません';
  END IF;
  IF (SELECT count(*) FROM solveloop_infra_check.persistence_probe) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM solveloop_infra_check.persistence_probe
      WHERE id = 1 AND marker = 'solveloop-volume-probe'
        AND embedding = '[1,2,3]'::vector
        AND embedding <-> '[4,6,3]'::vector = 5
    ) THEN
    RAISE EXCEPTION '保存行またはベクトル演算の検証に失敗しました';
  END IF;
END
$$;

SELECT current_setting('server_version') AS postgres_version,
  (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version,
  marker, embedding, embedding <-> '[4,6,3]'::vector AS l2_distance
FROM solveloop_infra_check.persistence_probe;
