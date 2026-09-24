import type { WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "node:fs";
import { getPendingOutbox, markOutboxSent, getConversationById } from "../db";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

let outboxTimer: NodeJS.Timeout | null = null;

/**
 * Loop que cada 2s revisa la tabla outbox y manda los mensajes humanos
 * pendientes a través de Baileys.
 *
 * Patrón outbox: bot y Next.js son procesos separados, no comparten memoria.
 * El dashboard escribe en outbox cuando el humano envía un mensaje.
 * El bot lee el outbox y lo envía por WhatsApp.
 */
export function startOutboxLoop(sock: WASocket): void {
  if (outboxTimer) return;

  outboxTimer = setInterval(async () => {
    const pending = getPendingOutbox(20);
    if (pending.length === 0) return;

    for (const item of pending) {
      // Usar la dirección completa guardada en la conversación (soporta @lid).
      // Fallback al formato clásico para filas antiguas sin jid registrado.
      const convo = getConversationById(item.conversation_id);
      const jid = convo?.jid ?? `${item.phone}@s.whatsapp.net`;
      try {
        if (item.type === "image" && item.media_path) {
          if (!fs.existsSync(item.media_path)) {
            logger.warn(`[bot] outbox #${item.id}: imagen no encontrada, descartada`);
            markOutboxSent(item.id);
            continue;
          }
          await sock.sendMessage(jid, {
            image: fs.readFileSync(item.media_path),
            caption: item.content || undefined,
          });
        } else {
          await sock.sendMessage(jid, { text: item.content });
        }
        markOutboxSent(item.id);
        logger.info(`[bot] → outbox enviado a ${item.phone}: "${item.content.slice(0, 40)}..."`);
      } catch (err) {
        // Dejar sent=0 para reintentar en el siguiente tick.
        // Útil cuando la conexión cae transitoriamente.
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          `[bot] outbox #${item.id} falló, reintentando`
        );
      }
    }
  }, 2000);
}

export function stopOutboxLoop(): void {
  if (outboxTimer) {
    clearInterval(outboxTimer);
    outboxTimer = null;
  }
}
