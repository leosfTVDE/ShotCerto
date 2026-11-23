// ===== ShotCerto — servidor da IA e dos pagamentos (Cloudflare Worker) =====
// Cole este código inteiro no Worker (Cloudflare > Workers > Editar código).
//
// Ligações e segredos necessários (Worker > Configurações > Variáveis):
//   SC                  -> ligação KV (crie um "KV namespace" chamado shotcerto e ligue com o nome SC)
//   ANTHROPIC_API_KEY   -> chave da IA (segredo)
//   FIREBASE_PROJECT_ID -> ID do projeto Firebase do ShotCerto (ex.: shotcerto-12345)
//   ADMIN_EMAILS        -> emails com acesso total de teste, separados por vírgula
//   ADMIN_KEY           -> uma senha sua, para as ferramentas de administrador (segredo)
//   HOTMART_HOTTOK      -> token "Hottok" do webhook da Hotmart (segredo)
//   KIWIFY_TOKEN        -> token do webhook da Kiwify (segredo)
// Opcionais:
//   PRODUTOS            -> mapa de produtos, ex.: {"hotmart:1234567":"mensal","kiwify:abc-123":"anual"}
//                          (sem isto, o plano é descoberto pelo nome do produto: "Mensal", "Anual", "Vitalício")
//   MODELO              -> modelo da IA (padrão: claude-haiku-5-5)

const LIMITES = { teste: 2, mensal: 30, anual: 30, vitalicio: 10, admin: 500 };
const DIA = 86400000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    try {
      const p = url.pathname.replace(/\/+$/, "") || "/";
      if (p === "/") return json({ ok: true, app: "ShotCerto API" });
      if (p === "/webhook/hotmart" && req.method === "POST") return await hotmart(req, env);
      if (p === "/webhook/kiwify" && req.method === "POST") return await kiwify(req, env, url);
      if (p.startsWith("/admin/")) return await admin(p, url, env);

      const user = await verificarFirebase(req, env);
      if (!user) return json({ erro: "Sessão expirada. Entre de novo.", codigo: "auth" }, 401);
      if (p === "/me") return json(await estado(user, env));
      if (p === "/analisar" && req.method === "POST") return await analisar(req, user, env);
      if (p === "/legenda" && req.method === "POST") return await legenda(req, user, env);
      return json({ erro: "Não encontrado" }, 404);
    } catch (e) {
      return json({ erro: "Erro no servidor: " + (e && e.message || e) }, 500);
    }
  }
};

// ---------- utilitários ----------
function cors(r) {
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Headers", "authorization, content-type");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return r;
}
function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } }));
}
const mesBR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 7); // mês no horário de Brasília
async function lerJSON(env, k, d) { const v = await env.SC.get(k); return v ? JSON.parse(v) : d; }

// ---------- login (token do Firebase) ----------
let JWKS = null, JWKS_T = 0;
function b64urlBytes(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
const b64urlTexto = s => new TextDecoder().decode(b64urlBytes(s));
async function verificarFirebase(req, env) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const partes = t.split(".");
  if (partes.length !== 3) return null;
  const [h64, p64, s64] = partes;
  const cab = JSON.parse(b64urlTexto(h64)), dados = JSON.parse(b64urlTexto(p64));
  const pid = env.FIREBASE_PROJECT_ID, agora = Date.now() / 1000;
  if (dados.aud !== pid || dados.iss !== "https://securetoken.google.com/" + pid || dados.exp < agora || !dados.email) return null;
  if (!JWKS || Date.now() - JWKS_T > 3600000) {
    const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    JWKS = (await r.json()).keys; JWKS_T = Date.now();
  }
  const jwk = JWKS.find(k => k.kid === cab.kid);
  if (!jwk) return null;
  const chave = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", chave, b64urlBytes(s64), new TextEncoder().encode(h64 + "." + p64));
  return ok ? { uid: dados.user_id, email: String(dados.email).toLowerCase(), verificado: !!dados.email_verified } : null;
}

// ---------- planos e limites ----------
async function estado(user, env) {
  const email = user.email, agora = Date.now();
  const admin = (env.ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean).includes(email) && user.verificado;
  // planos só valem com email confirmado (evita alguém criar conta com o email de outra pessoa)
  const conta = user.verificado ? await lerJSON(env, "u:" + email, null) : null;
  let plano = null, iaLimite = 0, iaAte = null, conteudo = false;
  if (admin) { plano = "admin"; iaLimite = LIMITES.admin; conteudo = true; }
  else if (conta) {
    if (conta.vitalicio) { plano = "vitalicio"; conteudo = true; if ((conta.iaAte || 0) > agora) { iaLimite = LIMITES.vitalicio; iaAte = conta.iaAte; } }
    if ((conta.plano === "mensal" || conta.plano === "anual") && (conta.ate || 0) > agora) {
      plano = conta.plano; conteudo = true; iaLimite = Math.max(iaLimite, LIMITES[conta.plano]);
    }
  }
  const usadas = +(await env.SC.get(`m:${email}:${mesBR()}`) || 0);
  const teste = +(await env.SC.get("t:" + email) || 0);
  return {
    plano, admin, conteudoCompleto: conteudo, verificado: user.verificado,
    iaLimite, iaUsadas: usadas, iaRestante: iaLimite ? Math.max(0, iaLimite - usadas) : 0,
    testeRestante: Math.max(0, LIMITES.teste - teste),
    assinaturaAte: conta && conta.ate || null, iaAte
  };
}
async function podeUsar(user, env) {
  const st = await estado(user, env);
  if (st.iaLimite > 0) {
    if (st.iaRestante > 0) return { tipo: "mes" };
    throw Object.assign(new Error("As análises deste mês acabaram. O contador volta no dia 1."), { codigo: "sem_creditos" });
  }
  if (st.testeRestante > 0) return { tipo: "teste" };
  throw Object.assign(new Error("As análises grátis acabaram. Escolha um plano para continuar."), { codigo: "sem_creditos" });
}
async function gastar(user, env, uso) {
  const k = uso.tipo === "mes" ? `m:${user.email}:${mesBR()}` : "t:" + user.email;
  const n = +(await env.SC.get(k) || 0) + 1;
  await env.SC.put(k, String(n), uso.tipo === "mes" ? { expirationTtl: 70 * DIA / 1000 } : undefined);
}

// ---------- IA ----------
const SISTEMA = `Você é o assistente do app ShotCerto: um fotógrafo simpático que ajuda pessoas comuns a tirar fotos melhores com o celular, para vender ou postar no Instagram e no WhatsApp.
Fale em português do Brasil, simples, curto e sem termos técnicos difíceis. Seja honesto, mas encorajador.
Responda APENAS com um objeto JSON válido, sem texto antes ou depois, sem markdown.`;

function corrigirJSON(txt) {
  const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("A IA não respondeu no formato certo. Tente de novo.");
  return JSON.parse(txt.slice(a, b + 1));
}
async function chamarIA(env, conteudo, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.MODELO || "claude-haiku-5-5", max_tokens: maxTokens, system: SISTEMA, messages: [{ role: "user", content: conteudo }] })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("IA indisponível agora (" + (j.error && j.error.message || r.status) + ")");
  return corrigirJSON((j.content || []).map(c => c.text || "").join(""));
}
const TOM = { simpatico: "simpático e próximo, com emojis na medida", profissional: "profissional e elegante, poucos emojis", urgente: "com senso de urgência (últimas unidades, aproveite), sem exagero" };
const OBJ = { vender: "vender produtos pelo Instagram e WhatsApp", pessoal: "postar no Instagram pessoal", negocio: "divulgar um negócio local", outro: "fotografar melhor" };
const objTexto = o => String(o || "vender").split(",").map(x => OBJ[x.trim()]).filter(Boolean).join(" e ") || OBJ.vender;
const vende = o => /vender|negocio/.test(String(o || "vender"));
function infoPessoa(b) {
  const l = [];
  if (b.produto) l.push("O que é: " + String(b.produto).slice(0, 120));
  if (b.preco) l.push("Preço: " + String(b.preco).slice(0, 40));
  if (b.detalhe) l.push("Detalhe importante: " + String(b.detalhe).slice(0, 160));
  return l.length ? "Informações dadas pela pessoa (use-as nas legendas, sem inventar outras):\n" + l.join("\n") : "A pessoa não deu informações extra: descreva só o que se vê.";
}
const REGRA_LEGENDA = `As legendas TÊM de falar desta foto em concreto: cite 1 ou 2 detalhes visíveis (cor, material, textura, cenário, luz, como está servido ou arrumado). Nada de frases genéricas que serviriam para qualquer foto.`;
const formatoLegendas = (objetivo, preco) => `"legendas": {
  "instagram": "legenda para o feed, 3 a 6 linhas curtas${vende(objetivo) ? ", com chamada para comprar ou chamar no direct" : ""}",
  "whatsapp": "mensagem curta para status ou catálogo do WhatsApp${vende(objetivo) ? (preco ? ", com o preço " + preco : ", com [preço] para a pessoa preencher") : ""}",
  "stories": "texto de 1 ou 2 linhas para pôr em cima da foto nos Stories"
},
"hashtags": ["4 a 6 hashtags relevantes em português, sem espaços"]`;

async function analisar(req, user, env) {
  const b = await req.json();
  if (!b.imagem || b.imagem.length > 4500000) return json({ erro: "Foto inválida ou grande demais." }, 400);
  const uso = await podeUsar(user, env).catch(e => e);
  if (uso instanceof Error) return json({ erro: uso.message, codigo: uso.codigo }, 402);
  const celular = b.celular === "android" ? "Android" : "iPhone";
  const pedido = `Analise esta foto.
Contexto: a pessoa quer ${objTexto(b.objetivo)}. A foto é de: ${b.situacao || "produto"}. O celular dela é ${celular}.
Tom das legendas: ${TOM[b.tom] || TOM.simpatico}.
${infoPessoa(b)}
${REGRA_LEGENDA}

Devolva exatamente este JSON:
{
"nota": número de 0 a 10 com uma casa decimal (seja justo: foto comum de celular costuma ficar entre 5 e 7),
"resumo": "1 frase curta sobre a foto, começando pelo ponto forte",
"descricao": "descrição objetiva e detalhada do que aparece na foto: objeto, cores, material, cenário (para escrever legendas depois)",
"barras": {"luz": 0-100, "fundo": 0-100, "angulo": 0-100, "nitidez": 0-100, "composicao": 0-100},
"dicas": [ 3 ou 4 itens {"tipo": "melhorar" ou "bom", "titulo": "até 6 palavras", "texto": "o que fazer, concreto e prático, até 2 frases"}; pelo menos 1 "bom" e as dicas de "melhorar" primeiro, da mais importante para a menos ],
"dica_celular": "1 dica prática específica para a câmera ou a edição do ${celular} que ajude nesta foto",
${formatoLegendas(b.objetivo, b.preco)}
}
Não invente marcas, preços nem características que não dá para ver na foto.`;
  const conteudo = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.imagem } },
    { type: "text", text: pedido }
  ];
  const res = await chamarIA(env, conteudo, 1400);
  await gastar(user, env, uso);
  return json(res);
}

async function legenda(req, user, env) {
  const b = await req.json();
  const uso = await podeUsar(user, env).catch(e => e);
  if (uso instanceof Error) return json({ erro: uso.message, codigo: uso.codigo }, 402);
  const pedido = `Escreva NOVAS legendas (diferentes da anterior) para esta foto.
Foto: ${b.descricao || b.situacao}. Tipo: ${b.situacao}. Objetivo: ${objTexto(b.objetivo)}.
Tom: ${TOM[b.tom] || TOM.simpatico}.
${infoPessoa(b)}
${REGRA_LEGENDA}
Legenda anterior (não repita): ${String(b.anterior || "").slice(0, 600)}
Devolva exatamente este JSON:
{
${formatoLegendas(b.objetivo, b.preco)}
}`;
  const res = await chamarIA(env, [{ type: "text", text: pedido }], 700);
  await gastar(user, env, uso);
  return json(res);
}

// ---------- pagamentos ----------
function qualPlano(env, origem, idProduto, nome) {
  try {
    const mapa = JSON.parse(env.PRODUTOS || "{}");
    if (mapa[origem + ":" + idProduto]) return mapa[origem + ":" + idProduto];
  } catch (e) {}
  const n = String(nome || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (n.includes("vitalic")) return "vitalicio";
  if (n.includes("anual")) return "anual";
  if (n.includes("mensal")) return "mensal";
  return null;
}
async function conceder(env, email, plano, origem) {
  if (!email || !plano) return;
  const k = "u:" + email, c = await lerJSON(env, k, {}), agora = Date.now();
  if (plano === "vitalicio") { c.vitalicio = true; c.iaAte = Math.max(c.iaAte || 0, agora) + 365 * DIA; }
  else {
    const base = Math.max(agora, c.ate || 0);
    c.plano = plano;
    c.ate = base + (plano === "anual" ? 365 : 30) * DIA + DIA; // +1 dia de tolerância
  }
  c.origem = origem; c.atualizado = agora;
  await env.SC.put(k, JSON.stringify(c));
}
async function revogar(env, email, plano) {
  if (!email) return;
  const k = "u:" + email, c = await lerJSON(env, k, null);
  if (!c) return;
  if (plano === "vitalicio" || !plano) { c.vitalicio = false; c.iaAte = 0; }
  if (plano !== "vitalicio") { c.plano = null; c.ate = 0; }
  c.atualizado = Date.now();
  await env.SC.put(k, JSON.stringify(c));
}
async function jaProcessado(env, chave) {
  if (!chave) return false;
  const k = "tx:" + chave;
  if (await env.SC.get(k)) return true;
  await env.SC.put(k, "1", { expirationTtl: 400 * DIA / 1000 });
  return false;
}
async function registarLog(env, origem, corpo, resultado) {
  const lista = await lerJSON(env, "log", []);
  lista.unshift({ quando: new Date().toISOString(), origem, resultado, corpo });
  await env.SC.put("log", JSON.stringify(lista.slice(0, 15)));
}

// Hotmart: Ferramentas > Webhook > URL: https://SEU-WORKER/webhook/hotmart
async function hotmart(req, env) {
  const corpo = await req.json().catch(() => ({}));
  if (!env.HOTMART_HOTTOK || req.headers.get("x-hotmart-hottok") !== env.HOTMART_HOTTOK) {
    await registarLog(env, "hotmart", corpo, "recusado: hottok errado");
    return new Response("unauthorized", { status: 401 });
  }
  const ev = corpo.event || "", d = corpo.data || {};
  const email = String((d.buyer && d.buyer.email) || (d.subscriber && d.subscriber.email) || "").toLowerCase().trim();
  const plano = qualPlano(env, "hotmart", d.product && d.product.id, d.product && d.product.name);
  const tx = d.purchase && d.purchase.transaction;
  let resultado = "ignorado";
  if (ev === "PURCHASE_APPROVED") {
    if (await jaProcessado(env, "hotmart:" + tx)) resultado = "repetido";
    else { await conceder(env, email, plano, "hotmart"); resultado = "concedido " + plano; }
  } else if (["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST"].includes(ev)) {
    await revogar(env, email, plano); resultado = "revogado " + plano;
  } // cancelamento de assinatura: o período já pago continua garantido
  await registarLog(env, "hotmart", corpo, resultado + " (" + ev + ", " + email + ")");
  return new Response("ok");
}

// Kiwify: Apps > Webhooks > URL: https://SEU-WORKER/webhook/kiwify
async function kiwify(req, env, url) {
  const bruto = await req.text();
  let corpo = {}; try { corpo = JSON.parse(bruto); } catch (e) {}
  const assinatura = url.searchParams.get("signature") || "";
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.KIWIFY_TOKEN || ""), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(bruto)))].map(x => x.toString(16).padStart(2, "0")).join("");
  if (!env.KIWIFY_TOKEN || sig !== assinatura) {
    await registarLog(env, "kiwify", corpo, "recusado: assinatura errada");
    return new Response("unauthorized", { status: 401 });
  }
  const cli = corpo.Customer || corpo.customer || {};
  const prod = corpo.Product || corpo.product || {};
  const email = String(cli.email || "").toLowerCase().trim();
  const plano = qualPlano(env, "kiwify", prod.product_id || prod.id, prod.product_name || prod.name);
  const status = corpo.order_status || "", ev = corpo.webhook_event_type || "";
  let resultado = "ignorado";
  if (status === "paid" && (!ev || ev === "order_approved" || ev === "subscription_renewed")) {
    const id = (corpo.order_id || "") + ":" + ev + ":" + (corpo.approved_date || corpo.updated_at || "");
    if (await jaProcessado(env, "kiwify:" + id)) resultado = "repetido";
    else { await conceder(env, email, plano, "kiwify"); resultado = "concedido " + plano; }
  } else if (["refunded", "chargedback"].includes(status) || ["order_refunded", "chargeback"].includes(ev)) {
    await revogar(env, email, plano); resultado = "revogado " + plano;
  }
  await registarLog(env, "kiwify", corpo, resultado + " (" + (ev || status) + ", " + email + ")");
  return new Response("ok");
}

// ---------- ferramentas de administrador (abrir no navegador) ----------
// Ver últimos avisos de pagamento:  /admin/avisos?chave=SUA_ADMIN_KEY
// Dar um plano a alguém:            /admin/dar?chave=SUA_ADMIN_KEY&email=pessoa@email.com&plano=mensal|anual|vitalicio
// Tirar o plano:                    /admin/tirar?chave=SUA_ADMIN_KEY&email=pessoa@email.com
// Ver a conta de alguém:            /admin/ver?chave=SUA_ADMIN_KEY&email=pessoa@email.com
async function admin(p, url, env) {
  if (!env.ADMIN_KEY || url.searchParams.get("chave") !== env.ADMIN_KEY) return json({ erro: "chave errada" }, 401);
  const email = String(url.searchParams.get("email") || "").toLowerCase().trim();
  if (p === "/admin/avisos") return json(await lerJSON(env, "log", []));
  if (p === "/admin/dar") {
    const plano = url.searchParams.get("plano");
    if (!email || !["mensal", "anual", "vitalicio"].includes(plano)) return json({ erro: "falta email ou plano" }, 400);
    await conceder(env, email, plano, "manual");
    return json({ ok: true, email, conta: await lerJSON(env, "u:" + email, null) });
  }
  if (p === "/admin/tirar") { await revogar(env, email, null); return json({ ok: true, email }); }
  if (p === "/admin/ver") return json({ email, conta: await lerJSON(env, "u:" + email, null), usadasEsteMes: +(await env.SC.get(`m:${email}:${mesBR()}`) || 0), testeUsado: +(await env.SC.get("t:" + email) || 0) });
  return json({ erro: "Não encontrado" }, 404);
}
