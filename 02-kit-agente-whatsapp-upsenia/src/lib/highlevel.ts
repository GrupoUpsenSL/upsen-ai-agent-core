import { getConversationById } from "./db";

// ============================================================
// Integración con el CRM de HighLevel (GoHighLevel / LeadConnector).
// Registra cada lead como Contacto (upsert por teléfono/email), le añade
// una Etiqueta y crea/actualiza una Oportunidad en el Pipeline configurado.
//
// Verificado en Task 2 (API v2 responde, PIT con scopes suficientes) y
// montado a mano en Task 3 (Pipeline "test - agente whatsapp", campos
// personalizados "Negocio"/"Necesidad", etiqueta y workflow de prueba).
//
// Config en .env.local:
//   HIGHLEVEL_API_KEY        Private Integration Token ("pit-...")
//   HIGHLEVEL_LOCATION_ID    Id de la sub-cuenta (locationId)
//   HIGHLEVEL_PIPELINE_ID    Id del pipeline donde crear la oportunidad
//   HIGHLEVEL_STAGE_ID       Id de la etapa inicial (opcional; si se omite,
//                            HighLevel usa la primera etapa del pipeline)
//   HIGHLEVEL_LEAD_TAG       Nombre de la etiqueta a aplicar (por defecto
//                            "agente-whatsapp")
//
// Los campos personalizados ("Negocio", "Necesidad") se resuelven por su
// fieldKey (contact.negocio / contact.necesidad) contra la Custom Fields
// API en vez de hardcodear sus IDs, para no romper si se recrean en otra
// sub-cuenta. Se cachean en memoria del proceso tras la primera llamada.
//
// Igual que airtable.ts: cualquier fallo aquí NUNCA debe tumbar la
// respuesta del agente. Todas las funciones devuelven { ok, message } y
// capturan sus propios errores.
// ============================================================

const API_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

export function highlevelConfigured(): boolean {
  return Boolean(process.env.HIGHLEVEL_API_KEY && process.env.HIGHLEVEL_LOCATION_ID);
}

/** Teléfono del lead: el del propio chat de WhatsApp es la fuente de verdad. */
export function leadPhone(conversationId: number, fallback?: string): string {
  const convo = getConversationById(conversationId);
  return (convo?.phone || fallback || "").trim();
}

export interface LeadData {
  nombre?: string;
  email?: string;
  negocio?: string;
  necesidad?: string;
}

export interface UpsertResult {
  ok: boolean;
  message: string;
  contactId?: string;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.HIGHLEVEL_API_KEY}`,
    Version: API_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// --- Resolución de Custom Fields por clave (cacheado en memoria del proceso) ---

let customFieldCache: Map<string, string> | null = null;

async function loadCustomFieldMap(): Promise<Map<string, string>> {
  if (customFieldCache) return customFieldCache;

  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  const res = await fetch(`${API_BASE}/locations/${locationId}/customFields`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`No se pudieron leer los Custom Fields (${res.status})`);

  const json = await res.json();
  const map = new Map<string, string>();
  for (const f of json.customFields ?? []) {
    // fieldKey viene como "contact.negocio" → guardamos también la parte
    // corta ("negocio") para no depender del prefijo.
    if (f.fieldKey) map.set(f.fieldKey, f.id);
    const short = f.fieldKey?.split(".").pop();
    if (short) map.set(short, f.id);
  }
  customFieldCache = map;
  return map;
}

/** Traduce { negocio, necesidad } a la forma [{ id, value }] que espera la API. */
async function buildCustomFields(data: LeadData): Promise<Array<{ id: string; value: string }>> {
  const pairs: Array<[string, string | undefined]> = [
    ["negocio", data.negocio],
    ["necesidad", data.necesidad],
  ];
  const present = pairs.filter(([, v]) => v && v.trim());
  if (!present.length) return [];

  const map = await loadCustomFieldMap();
  const out: Array<{ id: string; value: string }> = [];
  for (const [key, value] of present) {
    const id = map.get(key);
    // Si el campo no existe en esta sub-cuenta, lo omitimos (no rompemos el guardado).
    if (id) out.push({ id, value: value!.trim() });
  }
  return out;
}

// --- Contacto ---

/**
 * Crea o actualiza el contacto en HighLevel (upsert nativo por teléfono/email,
 * según la configuración de "Allow Duplicate Contact" de la sub-cuenta).
 * Devuelve el contactId para encadenar tag + oportunidad.
 */
export async function upsertContact(phone: string, data: LeadData): Promise<UpsertResult> {
  if (!highlevelConfigured()) return { ok: false, message: "HighLevel no configurado" };
  if (!phone) return { ok: false, message: "No se puede guardar el lead sin identificador (teléfono o sesión web)" };

  // El canal WEB usa "web:<sessionId>" como identificador interno (no es un
  // teléfono real), y la API de HighLevel valida el formato de "phone" y
  // rechaza cualquier cosa que no lo parezca (visto en producción: 400
  // "The string supplied did not seem to be a phone number"). En ese caso
  // NO enviamos el campo phone: el upsert usa el email como clave, que
  // siempre está presente aquí (guardarLead solo llama a esto cuando ya
  // tiene nombre Y email).
  const esTelefonoReal = !phone.startsWith("web:");

  const body: Record<string, unknown> = {
    locationId: process.env.HIGHLEVEL_LOCATION_ID,
  };
  if (esTelefonoReal) body.phone = phone;
  if (data.nombre) body.name = data.nombre;
  if (data.email) body.email = data.email;

  if (!esTelefonoReal && !data.email) {
    return { ok: false, message: "Lead de web sin email: no hay clave válida para HighLevel" };
  }

  try {
    const customFields = await buildCustomFields(data);
    if (customFields.length) body.customFields = customFields;
  } catch {
    // Si falla la resolución de custom fields, seguimos sin ellos: mejor
    // guardar el contacto pelado que no guardar nada.
  }

  try {
    const res = await fetch(`${API_BASE}/contacts/upsert`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { ok: false, message: `HighLevel ${res.status} (contacto): ${detail.slice(0, 160)}` };
    }
    const json = await res.json();
    const contactId = json.contact?.id;
    if (!contactId) return { ok: false, message: "HighLevel no devolvió el id del contacto" };
    return { ok: true, message: "Contacto guardado en HighLevel", contactId };
  } catch (err) {
    return { ok: false, message: `Error HighLevel (contacto): ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Etiqueta ---

export async function addTag(contactId: string, tag?: string): Promise<UpsertResult> {
  const tagName = tag || process.env.HIGHLEVEL_LEAD_TAG || "agente-whatsapp";
  try {
    const res = await fetch(`${API_BASE}/contacts/${contactId}/tags`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ tags: [tagName] }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { ok: false, message: `HighLevel ${res.status} (etiqueta): ${detail.slice(0, 160)}` };
    }
    return { ok: true, message: `Etiqueta "${tagName}" aplicada` };
  } catch (err) {
    return { ok: false, message: `Error HighLevel (etiqueta): ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Oportunidad ---

export async function upsertOpportunity(contactId: string, opportunityName: string): Promise<UpsertResult> {
  const pipelineId = process.env.HIGHLEVEL_PIPELINE_ID;
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  if (!pipelineId) return { ok: false, message: "HIGHLEVEL_PIPELINE_ID no configurado: oportunidad omitida" };

  const body: Record<string, unknown> = {
    pipelineId,
    locationId,
    contactId,
    name: opportunityName,
    status: "open",
  };
  if (process.env.HIGHLEVEL_STAGE_ID) body.pipelineStageId = process.env.HIGHLEVEL_STAGE_ID;

  try {
    const res = await fetch(`${API_BASE}/opportunities/upsert`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { ok: false, message: `HighLevel ${res.status} (oportunidad): ${detail.slice(0, 160)}` };
    }
    return { ok: true, message: "Oportunidad creada/actualizada en HighLevel" };
  } catch (err) {
    return { ok: false, message: `Error HighLevel (oportunidad): ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Orquestador: lo que llama guardar-lead.ts ---

/**
 * Hace el flujo completo (contacto → etiqueta → oportunidad) en un único
 * paso, igual que upsertLead() en airtable.ts. Cada sub-paso captura sus
 * propios errores; un fallo en la etiqueta o la oportunidad NO deshace el
 * contacto ya guardado, y nunca lanza (throw) hacia quien la llama.
 */
export async function upsertLead(phone: string, data: LeadData): Promise<UpsertResult> {
  const contactRes = await upsertContact(phone, data);
  if (!contactRes.ok || !contactRes.contactId) return contactRes;

  const notes: string[] = [];

  const tagRes = await addTag(contactRes.contactId);
  if (!tagRes.ok) notes.push(tagRes.message);

  const oppRes = await upsertOpportunity(contactRes.contactId, data.nombre || `Lead WhatsApp ${phone}`);
  if (!oppRes.ok) notes.push(oppRes.message);

  return {
    ok: true, // el contacto (lo mínimo imprescindible) sí se guardó
    contactId: contactRes.contactId,
    message: notes.length ? `Lead guardado en HighLevel (con avisos: ${notes.join(" · ")})` : "Lead guardado en HighLevel (contacto + etiqueta + oportunidad)",
  };
}