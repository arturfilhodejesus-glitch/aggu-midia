// Robô do funil de link do @agguoficial (Cloudflare Worker).
// Recebe o webhook da Meta (comentários e mensagens do Instagram) e segue o fluxo
// aprovado pelo Artur em 16/11/2026 (guia-respostas.md, seção 4):
// comentário com a palavra -> resposta pública + DM 1 (sem link) -> "sim" ->
// DM 2 com botão [Já segui] -> "Já segui" -> só o link combinado.
// Segredos (configurados no painel da Cloudflare, nunca no código):
//   IG_TOKEN      token da conta @agguoficial (Instagram Login)
//   VERIFY_TOKEN  texto combinado para a Meta confirmar o webhook
//   APP_SECRET    (opcional) chave secreta do app, para conferir a assinatura
// Variáveis: IG_ID (id da conta), GRAPH_HOST (padrão graph.instagram.com)
// KV: FUNIL (estado de cada pessoa)
// Funis ativos: lidos de funis.json no repositório público aggu-midia.

const FUNIS_URL = "https://raw.githubusercontent.com/arturfilhodejesus-glitch/aggu-midia/claude/project-thread-gvs5xc/funis/funis.json";

const TXT = {
  publica: (u) => `Te mandei no direct, @${u}!`,
  dm1: (assunto) => `Oi! Vi seu comentário no vídeo ${assunto}. Quer que eu te mande o link? Me responde aqui com um "sim" 🙂`,
  dm2: "Fechado! Só um detalhe: o link eu só consigo mandar pra quem segue a @agguoficial. Você já segue? Se ainda não, segue lá rapidinho e toca no botão aqui embaixo 👇",
  insiste: "Sem problema! É rapidinho: toca no @agguoficial aqui em cima, segue, e volta aqui no botão 👇",
};
const BOTAO = [{ content_type: "text", title: "Já segui", payload: "JA_SEGUI" }];

const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

async function funis() {
  const r = await fetch(FUNIS_URL, { cf: { cacheTtl: 60 } });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.funis || []).filter((f) => f.ativo !== false);
}

function bate(f, texto) {
  const t = norm(texto);
  return (f.palavras || []).some((p) => {
    const n = norm(p);
    return t === n || (` ${t} `).includes(` ${n} `);
  });
}

async function graph(env, path, body) {
  const host = env.GRAPH_HOST || "graph.instagram.com";
  const r = await fetch(`https://${host}/v21.0/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.IG_TOKEN}` },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) console.log("graph erro", path, r.status, txt);
  await registrar(env, { tipo: "envio", path: path.split("/").pop(), ok: r.ok, status: r.status, erro: r.ok ? undefined : txt.slice(0, 300) });
  return { ok: r.ok, txt };
}

const enviar = (env, recipient, message) => graph(env, `${env.IG_ID || "me"}/messages`, { recipient, message });

// Registro curto dos últimos eventos (para conferir de fora em /status?k=VERIFY_TOKEN).
async function registrar(env, item) {
  try {
    const v = JSON.parse((await env.FUNIL.get("log")) || "[]");
    v.unshift({ t: new Date().toISOString(), ...item });
    await env.FUNIL.put("log", JSON.stringify(v.slice(0, 60)));
  } catch (e) { console.log("log falhou", e); }
}

async function estado(env, uid) { const v = await env.FUNIL.get(`u:${uid}`); return v ? JSON.parse(v) : null; }
async function salvar(env, uid, st) { await env.FUNIL.put(`u:${uid}`, JSON.stringify(st), { expirationTtl: 60 * 60 * 24 * 8 }); }

async function comentario(env, v) {
  const uid = v.from && v.from.id;
  if (!uid || uid === env.IG_ID || (v.from.username || "") === "agguoficial") return;
  if (v.parent_id) return; // resposta dentro de outro comentário
  const mediaId = v.media && v.media.id;
  const f = (await funis()).find((x) => x.media_id === mediaId);
  if (!f || !bate(f, v.text)) return;
  const chave = `c:${v.id}`;
  if (await env.FUNIL.get(chave)) return;
  await env.FUNIL.put(chave, "1", { expirationTtl: 60 * 60 * 24 * 30 });
  const entregue = await env.FUNIL.get(`d:${mediaId}:${uid}`);
  await graph(env, `${v.id}/replies`, { message: TXT.publica(v.from.username || "") });
  if (entregue) return; // já recebeu o link deste post
  const r = await enviar(env, { comment_id: v.id }, { text: TXT.dm1(f.assunto || "") });
  if (r.ok) await salvar(env, uid, { etapa: "dm1", media: mediaId, ts: Date.now() });
}

async function mensagem(env, m) {
  if (!m.message || m.message.is_echo) return;
  const uid = m.sender && m.sender.id;
  if (!uid || uid === env.IG_ID) return;
  const st = await estado(env, uid);
  if (!st || st.etapa === "fim") return; // fora do funil: fica para o Claude/Artur
  const f = (await funis()).find((x) => x.media_id === st.media);
  if (!f) return;
  const texto = norm(m.message.text);
  const payload = m.message.quick_reply && m.message.quick_reply.payload;
  const link = async () => {
    const r = await enviar(env, { id: uid }, { text: f.mensagem_link });
    if (r.ok) { await salvar(env, uid, { ...st, etapa: "fim" }); await env.FUNIL.put(`d:${st.media}:${uid}`, "1", { expirationTtl: 60 * 60 * 24 * 90 }); }
  };
  if (st.etapa === "dm1") {
    const r = await enviar(env, { id: uid }, { text: TXT.dm2, quick_replies: BOTAO });
    if (r.ok) await salvar(env, uid, { ...st, etapa: "dm2" });
    return;
  }
  const segui = payload === "JA_SEGUI" || /\b(ja segui|segui|sigo|pronto|ja sigo|feito|ok|sim)\b/.test(texto);
  const nao = /\b(nao|nunca)\b/.test(texto);
  if (st.etapa === "dm2" && !segui && nao) {
    const r = await enviar(env, { id: uid }, { text: TXT.insiste, quick_replies: BOTAO });
    if (r.ok) await salvar(env, uid, { ...st, etapa: "insistiu" });
    return;
  }
  await link(); // seguiu, ou insistiu uma vez e a pessoa respondeu de novo
}

async function assinaturaOk(env, req, corpo) {
  if (!env.APP_SECRET) return true;
  const sig = req.headers.get("x-hub-signature-256") || "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(corpo));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig === `sha256=${hex}`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/status") {
      if (!env.VERIFY_TOKEN || url.searchParams.get("k") !== env.VERIFY_TOKEN) return new Response("não", { status: 403 });
      return new Response((await env.FUNIL.get("log")) || "[]", { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (req.method === "GET") {
      if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env.VERIFY_TOKEN)
        return new Response(url.searchParams.get("hub.challenge") || "");
      return new Response("ok");
    }
    if (req.method !== "POST") return new Response("método não aceito", { status: 405 });
    const corpo = await req.text();
    if (!(await assinaturaOk(env, req, corpo))) return new Response("assinatura inválida", { status: 401 });
    let j; try { j = JSON.parse(corpo); } catch { return new Response("ok"); }
    const tarefas = [];
    for (const e of j.entry || []) {
      for (const c of e.changes || []) tarefas.push(registrar(env, { tipo: "recebido", campo: c.field, de: c.value && c.value.from && c.value.from.username, texto: ((c.value && c.value.text) || "").slice(0, 80), media: c.value && c.value.media && c.value.media.id }));
      for (const m of e.messaging || []) tarefas.push(registrar(env, { tipo: "recebido", campo: "messages", de: m.sender && m.sender.id, eco: !!(m.message && m.message.is_echo), texto: ((m.message && m.message.text) || "").slice(0, 80) }));
    }
    await Promise.allSettled(tarefas.splice(0));
    for (const e of j.entry || []) {
      for (const c of e.changes || []) if (c.field === "comments" && c.value) tarefas.push(comentario(env, c.value));
      for (const m of e.messaging || []) tarefas.push(mensagem(env, m));
    }
    ctx.waitUntil(Promise.allSettled(tarefas));
    return new Response("ok");
  },
};
