-- ============================================================
-- schema.sql — Comentario Anonimo
-- DDL do banco D1. Tudo com IF NOT EXISTS: pode rodar várias
-- vezes sem quebrar.
-- ------------------------------------------------------------
-- Observações de design:
-- - criado_em é TEXTO em ISO 8601 (UTC), ex.:
--     "2025-11-01T12:34:56.789Z"
--   Isso mantém a ordenação lexicográfica correta e facilita
--   o polling incremental do front.
-- - id é TEXTO: UUID v4 gerado pelo Worker com
--     crypto.randomUUID()
-- - ip_hash guarda o HASH SHA-256 do IP + salt — NUNCA o IP puro.
--   É usado apenas para o rate limit anônimo.
-- ============================================================
 
-- Tabela principal de comentários
CREATE TABLE IF NOT EXISTS comentarios (
    id        TEXT PRIMARY KEY,   -- UUID gerado pelo Worker
    texto     TEXT NOT NULL,      -- conteúdo do comentário (até 400 caracteres)
    criado_em TEXT NOT NULL,      -- timestamp ISO 8601 em UTC
    ip_hash   TEXT                -- hash SHA-256 do IP + salt (nunca o IP puro)
);
 
-- Índice para ordenar por data rapidamente (mural em ordem cronológica)
CREATE INDEX IF NOT EXISTS idx_comentarios_criado_em
    ON comentarios (criado_em);
 
-- Índice para o rate limit: contar comentários recentes por ip_hash
CREATE INDEX IF NOT EXISTS idx_comentarios_ip_hash
    ON comentarios (ip_hash);
