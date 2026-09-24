import { NextRequest, NextResponse } from "next/server";
import {
  getOrCreateConversation,
  getConversationById,
  insertMessage,
  getRecentHistory,
  getSetting,
} from "@/lib/db";
import { generateReply } from "@/lib/openrouter";
import { getLeadMemory, memoryToPrompt, rememberConversation } from "@/lib/memory";
import { guardInbound, guardOutbound, GUARD_FALLBACK } from "@/lib/guardrails";
import { saneaHumano, dividirMensajes } from "@/lib/humanize";

// ============================================================
// Canal WEB — mismo motor que el canal de WhatsApp (misma lógica, mismo
// prompt, mismo guardrails, misma memoria y el mismo CRM vía guardarLead),
// pero SIN ninguna dependencia de Baileys. Este archivo vive dentro del
// proceso "WEB" (Next.js), que ya corre separado del proceso "BOT" gracias
// a `concurrently` (ver package.json → start:all). Por eso un fallo aquí
// NUNCA puede tumbar el canal de WhatsApp, y viceversa: son procesos
// independientes desde el arranque, no solo módulos separados.
//
// A diferencia de WhatsApp, aquí NO hay buffer de agrupación: el widget
// espera una respuesta inmediata a cada mensaje (como cualquier chat web),
// así que se responde en el propio request/response en vez de programarse
// con un timeout.
//
// Identidad del lead: como no hay número de teléfono real, usamos
// "web:<sessionId>" como clave única en conversations.phone. El sessionId
// lo genera y persiste el propio widget.js (localStorage) para que la
// misma persona conserve memoria/historial entre visitas.
// ============================================================

const RESPUESTA_FALLBACK = "Perdona, se me cruzó un cable un momento. ¿Me lo repites?";

// El widget puede incrustarse en CUALQUIER web externa (ese es el objetivo
// de la tarea), así que este endpoint necesita CORS abierto — igual que
// Intercom/Crisp aceptan peticiones desde el dominio del cliente que los instala.
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

interface WidgetMessageBody {
  sessionId?: string;
  message?: string;
  name?: string; // opcional: si el widget pide el nombre antes de chatear
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as WidgetMessageBody;
    const sessionId = (body.sessionId || "").trim();
    const text = (body.message || "").trim();

    if (!sessionId || !text) {
      return NextResponse.json(
        { error: "Faltan sessionId o message" },
        { status: 400, headers: corsHeaders() }
      );
    }

    const phone = `web:${sessionId}`;
    const convo = getOrCreateConversation(phone, body.name);

    // Mismo guardrail de entrada que WhatsApp: trunca lo desproporcionado y
    // corta el flood. En flood, no respondemos (igual que en handler.ts).
    const inbound = guardInbound(convo.id, text);
    insertMessage(convo.id, "user", inbound.text);
    if (!inbound.allowed) {
      return NextResponse.json(
        { replies: [], blocked: true },
        { headers: corsHeaders() }
      );
    }

    // Si un humano tomó la conversación desde el dashboard, el bot calla
    // (igual que en WhatsApp): el mensaje queda guardado y visible, pero sin respuesta del agente.
    const fresh = getConversationById(convo.id);
    if (!fresh || fresh.mode !== "AI") {
      return NextResponse.json({ replies: [], handedOff: true }, { headers: corsHeaders() });
    }

    // Pausa global desde Ajustes: aplica también al canal web.
    if (getSetting("paused") === "1") {
      return NextResponse.json({ replies: [], paused: true }, { headers: corsHeaders() });
    }

    const history = getRecentHistory(convo.id, 20);

    let memoryContext = "";
    try {
      const mem = await getLeadMemory(phone);
      if (mem) {
        const lastSeenMs = mem.last_seen ? Date.parse(mem.last_seen) : 0;
        const reencuentro = !lastSeenMs || Date.now() - lastSeenMs > 60 * 60 * 1000;
        memoryContext = memoryToPrompt(mem, reencuentro);
      }
    } catch {
      memoryContext = "";
    }

    let reply: string;
    try {
      reply = await generateReply({ history, conversationId: convo.id, memoryContext });
    } catch (err) {
      console.error("[widget] error generando respuesta:", err instanceof Error ? err.message : err);
      const fb = saneaHumano(RESPUESTA_FALLBACK);
      insertMessage(convo.id, "assistant", fb);
      return NextResponse.json({ replies: [fb] }, { headers: corsHeaders() });
    }

    if (!reply || reply.trim() === "") {
      const fb = saneaHumano(RESPUESTA_FALLBACK);
      insertMessage(convo.id, "assistant", fb);
      return NextResponse.json({ replies: [fb] }, { headers: corsHeaders() });
    }

    const contextoLead = history.filter((m) => m.role === "user").map((m) => m.content).join(" ");
    const guard = guardOutbound(reply, contextoLead);
    if (!guard.ok) {
      const fb = saneaHumano(GUARD_FALLBACK);
      insertMessage(convo.id, "assistant", fb);
      return NextResponse.json({ replies: [fb] }, { headers: corsHeaders() });
    }

    // Igual que WhatsApp: el modelo puede pedir varios mensajes separados con "|||".
    const partes = dividirMensajes(reply);
    for (const parte of partes) {
      insertMessage(convo.id, "assistant", parte);
    }

    void rememberConversation(phone, {
      waName: fresh.name,
      resumen: partes.join("\n").slice(0, 1200),
    });

    return NextResponse.json({ replies: partes }, { headers: corsHeaders() });
  } catch (err) {
    // Red de seguridad final: pase lo que pase, el widget nunca debe recibir
    // un 500 en seco sin más — mejor un fallback legible.
    console.error("[widget] error inesperado:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { replies: [RESPUESTA_FALLBACK] },
      { status: 200, headers: corsHeaders() }
    );
  }
}