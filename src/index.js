// ============================================================
// src/index.js — Comentario Anonimo
// Worker em módulo ES: API + fallback de assets estáticos.
// O front vive em ./public e é servido pelo próprio Worker,
// então site e API ficam no mesmo domínio (sem CORS em produção).
// ============================================================
 
// Salt fixo usado no hash do IP. Trocar este valor invalida os
// hashes antigos (o rate limit "esquece" quem enviou antes).
const SALT_IP = "comentario-anonimo::salt-fixo::v1";
 
// Limite máximo de comentários por IP por hora
const LIMITE_POR_HORA = 10;
 
// ------------------------------------------------------------
// AUTO-INICIALIZAÇÃO DO SCHEMA
// ------------------------------------------------------------
// IMPORTANTE: o BANCO em si (a criação do database_id e do
// binding "DB") NÃO pode ser criado por código — isso é um
// passo manual no painel da Cloudflare ou via `wrangler d1
// create`. O que este código faz é apenas criar TABELAS e
// ÍNDICES dentro de um banco que já existe.
//
// Na primeira requisição de API, o Worker cria as tabelas
// sozinho (CREATE TABLE IF NOT EXISTS). Depois disso, a flag
// `schemaGarantido` evita repetir o DDL em cada requisição.
// Isso torna o Worker auto-suficiente.
let schemaGarantido = false;
 
async function garantirSchema(env) {
  if (schemaGarantido) return; // já rodou nesta instância
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS comentarios (
      id        TEXT PRIMARY KEY,
      texto     TEXT NOT NULL,
      criado_em TEXT NOT NULL,
      ip_hash   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_comentarios_criado_em
      ON comentarios (criado_em);
    CREATE INDEX IF NOT EXISTS idx_comentarios_ip_hash
      ON comentarios (ip_hash);
  `);
  schemaGarantido = true;
}
 
// ------------------------------------------------------------
// CORS
// ------------------------------------------------------------
// Em produção front e API têm a mesma origem, mas os headers
// são incluídos por segurança (ex.: preview em outro domínio).
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
 
function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}
 
// ------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------
 
// Hash SHA-256 do IP + salt. O IP NUNCA é armazenado em texto
// puro: guardamos apenas este hash, que serve só para o rate
// limit anônimo (não é possível reverter ao IP).
async function hashIp(ip) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(SALT_IP + ip)
  );
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
 
// Melhor tentativa de obter o IP do cliente
function ipDoCliente(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "desconhecido"
  );
}
 
// ------------------------------------------------------------
// Rotas da API
// ------------------------------------------------------------
 
// GET /api/comentarios?limite=200
// Lista os comentários em ordem cronológica ASC (mais antigos
// primeiro, para a TV exibir em ordem). O ip_hash NUNCA sai no JSON.
async function listarComentarios(request, env) {
  const url = new URL(request.url);
  let limite = parseInt(url.searchParams.get("limite") || "200", 10);
  if (Number.isNaN(limite) || limite < 1) limite = 200;
  if (limite > 500) limite = 500;
 
  const { results } = await env.DB.prepare(
    "SELECT id, texto, criado_em FROM comentarios ORDER BY criado_em ASC LIMIT ?1"
  ).bind(limite).all();
 
  return json({ ok: true, comentarios: results });
}
 
// GET /api/comentarios/desde/:timestamp
// Retorna apenas comentários com criado_em MAIOR que o timestamp
// informado (ISO 8601). Usado pelo polling do front para pegar
// só o que é novo.
async function listarDesde(request, env, timestamp) {
  // decodifica possíveis %3A etc. no timestamp da URL
  const iso = decodeURIComponent(timestamp);
  // validação simples de ISO 8601
  const padraoIso = new RegExp("^\\d{4}-\\d{2}-\\d{2}T");
  if (!padraoIso.test(iso)) {
    return json({ ok: false, erro: "Timestamp inválido. Use o formato ISO 8601." }, 400);
  }
 
  const { results } = await env.DB.prepare(
    "SELECT id, texto, criado_em FROM comentarios WHERE criado_em > ?1 ORDER BY criado_em ASC LIMIT 500"
  ).bind(iso).all();
 
  return json({ ok: true, comentarios: results });
}
 
// POST /api/comentarios  — body JSON: { texto: "..." }
async function criarComentario(request, env) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return json({ ok: false, erro: "Body inválido: envie JSON válido." }, 400);
  }
 
  // ---- Validações ----
  const textoBruto = corpo && corpo.texto;
  if (typeof textoBruto !== "string") {
    return json({ ok: false, erro: "O campo 'texto' é obrigatório e deve ser uma string." }, 400);
  }
  const texto = textoBruto.trim();
  if (texto.length === 0) {
    return json({ ok: false, erro: "O comentário não pode ficar vazio." }, 400);
  }
  if (texto.length > 400) {
    return json({ ok: false, erro: "O comentário deve ter no máximo 400 caracteres." }, 400);
  }
 
  // ---- Rate limit: no máximo 10 comentários por IP por hora ----
  const ipHash = await hashIp(ipDoCliente(request));
  const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM comentarios WHERE ip_hash = ?1 AND criado_em > ?2"
  ).bind(ipHash, umaHoraAtras).all();
  const totalRecente = (results && results[0] && results[0].total) || 0;
  if (totalRecente >= LIMITE_POR_HORA) {
    return json(
      { ok: false, erro: "Você já enviou vários comentários neste período. Por favor, espere um pouco antes de enviar novamente." },
      429
    );
  }
 
  // ---- Inserção ----
  const id = crypto.randomUUID();
  const criadoEm = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO comentarios (id, texto, criado_em, ip_hash) VALUES (?1, ?2, ?3, ?4)"
  ).bind(id, texto, criadoEm, ipHash).run();
 
  return json({ ok: true, comentario: { id, texto, criado_em: criadoEm } }, 201);
}
 
// GET /api/stats — contagem total de comentários
async function stats(env) {
  const { results } = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM comentarios"
  ).all();
  return json({ ok: true, total: (results && results[0] && results[0].total) || 0 });
}
 
// ------------------------------------------------------------
// Roteador principal
// ------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const caminho = url.pathname;
 
    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
 
    // ---- Rotas /api/* ----
    if (caminho.startsWith("/api/")) {
      try {
        // garante que as tabelas existem (roda só na 1ª requisição)
        await garantirSchema(env);
 
        // GET /api/comentarios
        if (caminho === "/api/comentarios" && request.method === "GET") {
          return await listarComentarios(request, env);
        }
 
        // GET /api/comentarios/desde/:timestamp
        const mDesde = caminho.match(/^\/api\/comentarios\/desde\/(.+)$/);
        if (mDesde && request.method === "GET") {
          return await listarDesde(request, env, mDesde[1]);
        }
 
        // POST /api/comentarios
        if (caminho === "/api/comentarios" && request.method === "POST") {
          return await criarComentario(request, env);
        }
 
        // GET /api/stats
        if (caminho === "/api/stats" && request.method === "GET") {
          return await stats(env);
        }
 
        // 404 em JSON para rotas /api/* desconhecidas
        return json({ ok: false, erro: "Rota de API não encontrada." }, 404);
      } catch (erro) {
        console.error("Erro na API:", erro);
        return json({ ok: false, erro: "Erro interno do servidor. Tente novamente mais tarde." }, 500);
      }
    }
 
    // ---- Fallback: servir o front estático ----
    // Qualquer rota fora de /api/ é atendida pelos assets de
    // ./public (index.html na raiz). Assim o Worker serve o
    // site e a API no mesmo domínio — sem problema de CORS.
    return env.ASSETS.fetch(request);
  },
};
