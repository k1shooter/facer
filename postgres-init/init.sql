-- init.sql
-- 데이터베이스가 존재하면 해당 데이터베이스로 연결 전환
\c facer_db;

-- pgvector 확장 활성화 (이미 활성화되어 있으면 무시됨)
CREATE EXTENSION IF NOT EXISTS vector;