import { getConversationById } from "./db";

// ============================================================
// Integración con el CRM de HighLevel (GoHighLevel / LeadConnector).
// Registra cada lead como Contacto, le añade una Etiqueta y crea/actualiza
// UNA Oportunidad abierta en el Pipeline configurado. Para no duplicar, el
// contacto se busca primero por TELÉFONO (en WhatsApp siempre lo tenemos), después
// por email, y solo se crea si no existe; la oportunidad abierta se reutiliza.
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
  empresa?: string; // nombre de la empresa/clínica/negocio del lead → campo estándar companyName
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

// --- Utilidades de coincidencia ---

/** Solo dígitos del teléfono. */
function digits(phone: string | undefined | null): string {
  return (phone ?? "").replace(/\D/g, "");
}

/**
 * Dos teléfonos son el mismo si coinciden sus últimos 9 dígitos. Así "+34 672 78 97 44",
 * "672789744" y "0034672789744" cuentan como iguales (cubre prefijos distintos).
 */
export function samePhone(a: string | undefined | null, b: string | undefined | null): boolean {
  const da = digits(a);
  const db = digits(b);
  if (da.length < 7 || db.length < 7) return false;
  return da.slice(-9) === db.slice(-9);
}

function sameEmail(a: string | undefined | null, b: string | undefined | null): boolean {
  const ea = (a ?? "").trim().toLowerCase();
  return ea !== "" && ea === (b ?? "").trim().toLowerCase();
}

export interface ContactLite {
  id: string;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
}

/**
 * Busca contactos por texto libre (teléfono o email) y devuelve los candidatos.
 * El resultado NO se da por bueno: quien llama debe confirmar que el teléfono o el
 * email coinciden de verdad (la búsqueda de HighLevel es aproximada).
 */
export async function searchContacts(query: string): Promise<ContactLite[]> {
  const params = new URLSearchParams({
    locationId: process.env.HIGHLEVEL_LOCATION_ID ?? "",
    query,
    limit: "20",
  });
  const res = await fetch(`${API_BASE}/contacts/?${params}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`búsqueda de contactos (${res.status}): ${(await res.text()).slice(0, 120)}`);
  const json = await res.json();
  return (json.contacts ?? []) as ContactLite[];
}

export async function findContactByPhone(phone: string): Promise<ContactLite | null> {
  const found = await searchContacts(phone);
  return found.find((c) => samePhone(c.phone, phone)) ?? null;
}

export async function findContactByEmail(email: string): Promise<ContactLite | null> {
  const found = await searchContacts(email);
  return found.find((c) => sameEmail(c.email, email)) ?? null;
}

// --- Contacto ---

/**
 * Busca el contacto existente (1º por teléfono, 2º por email) y lo ACTUALIZA; solo si
 * no existe lo crea. Devuelve el contactId para encadenar tag + oportunidad.
 *
 * - Coincide por teléfono: se actualiza. Si el email nuevo ya pertenece a OTRO
 *   contacto, NO se cambia el email de este (para no mezclar personas) y se avisa.
 * - Coincide solo por email: se actualiza ese contacto y se le completa el teléfono
 *   solo si no tenía; nunca se sobrescribe un teléfono existente.
 * - No coincide: se crea.
 */
export async function upsertContact(phone: string, data: LeadData): Promise<UpsertResult> {
  if (!highlevelConfigured()) return { ok: false, message: "HighLevel no configurado" };
  if (!phone) return { ok: false, message: "No se puede guardar el lead sin identificador (teléfono o sesión web)" };

  // El canal WEB usa "web:<sessionId>" como identificador interno (no es un
  // teléfono real) y la API de HighLevel rechaza un "phone" con ese formato (400
  // "The string supplied did not seem to be a phone number"). En ese caso NO se
  // busca ni se envía teléfono: la clave es el email, que guardarLead siempre
  // tiene aquí (solo llama cuando ya hay nombre Y email).
  const esTelefonoReal = !phone.startsWith("web:");
  if (!esTelefonoReal && !data.email) {
    return { ok: false, message: "Lead de web sin email: no hay clave válida para HighLevel" };
  }

  const aviso: string[] = [];
  let existing: ContactLite | null = null;
  let emailOwner: ContactLite | null = null;
  try {
    existing = esTelefonoReal ? await findContactByPhone(phone) : null;
    if (data.email) emailOwner = await findContactByEmail(data.email);
  } catch (err) {
    // Sin poder buscar, NO creamos a ciegas: crearía un duplicado. Se avisa y el
    // agente lo reintentará en la siguiente llamada a guardarLead.
    return { ok: false, message: `Error HighLevel (buscar contacto): ${err instanceof Error ? err.message : String(err)}` };
  }

  let customFields: Array<{ id: string; value: string }> = [];
  try {
    customFields = await buildCustomFields(data);
  } catch {
    // Mejor guardar el contacto pelado que no guardar nada.
  }

  // 1) Ya existe por teléfono → actualizar.
  if (existing) {
    const body: Record<string, unknown> = {};
    if (data.nombre) body.name = data.nombre;
    if (data.empresa) body.companyName = data.empresa;
    if (data.email) {
      if (emailOwner && emailOwner.id !== existing.id) {
        aviso.push(`el email ya pertenece a otro contacto (${emailOwner.id}); no se cambia`);
      } else {
        body.email = data.email;
      }
    }
    return updateContact(existing.id, body, customFields, aviso);
  }

  // 2) No existe por teléfono pero sí por email → actualizar ese contacto.
  if (emailOwner) {
    const body: Record<string, unknown> = {};
    if (data.nombre) body.name = data.nombre;
    if (data.empresa) body.companyName = data.empresa;
    if (!esTelefonoReal) {
      // canal web: no hay teléfono que completar
    } else if (!digits(emailOwner.phone)) body.phone = phone;
    else aviso.push(`contacto encontrado por email con otro teléfono (${emailOwner.phone}); no se modifica`);
    return updateContact(emailOwner.id, body, customFields, aviso);
  }

  // 3) No existe → crear. Se usa el upsert nativo solo para crear (cubre carreras).
  const body: Record<string, unknown> = {
    locationId: process.env.HIGHLEVEL_LOCATION_ID,
  };
  if (esTelefonoReal) body.phone = phone;
  if (data.nombre) body.name = data.nombre;
  if (data.empresa) body.companyName = data.empresa;
  if (data.email) body.email = data.email;
  if (customFields.length) body.customFields = customFields;

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
    return { ok: true, message: "Contacto creado en HighLevel", contactId };
  } catch (err) {
    return { ok: false, message: `Error HighLevel (contacto): ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function updateContact(
  contactId: string,
  body: Record<string, unknown>,
  customFields: Array<{ id: string; value: string }>,
  aviso: string[]
): Promise<UpsertResult> {
  const put = async (payload: Record<string, unknown>) =>
    fetch(`${API_BASE}/contacts/${contactId}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });

  try {
    const withFields = customFields.length
      ? { ...body, customFields: customFields.map((f) => ({ id: f.id, fieldValue: f.value })) }
      : body;
    let res = await put(withFields);
    if (!res.ok && customFields.length) {
      // Si falla por los campos personalizados, guardamos al menos lo básico.
      aviso.push("no se pudieron actualizar los campos personalizados");
      res = await put(body);
    }
    if (!res.ok) {
      const detail = await res.text();
      return { ok: false, message: `HighLevel ${res.status} (actualizar contacto): ${detail.slice(0, 160)}` };
    }
    const nota = aviso.length ? ` (${aviso.join(" · ")})` : "";
    return { ok: true, message: `Contacto actualizado en HighLevel${nota}`, contactId };
  } catch (err) {
    return { ok: false, message: `Error HighLevel (actualizar contacto): ${err instanceof Error ? err.message : String(err)}` };
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

export interface OpportunityLite {
  id: string;
  name?: string;
  status?: string;
  pipelineId?: string;
  contactId?: string;
  contact?: { id?: string };
}

/**
 * Oportunidades ABIERTAS de este contacto en el pipeline configurado.
 * Se envían los filtros en ambos formatos (camelCase y snake_case) y además se
 * confirma en cliente que contacto, pipeline y estado coinciden, para no tocar
 * nunca la oportunidad de otra persona si HighLevel ignorase algún filtro.
 */
export async function listOpenOpportunities(contactId: string): Promise<OpportunityLite[]> {
  const pipelineId = process.env.HIGHLEVEL_PIPELINE_ID ?? "";
  const locationId = process.env.HIGHLEVEL_LOCATION_ID ?? "";
  const params = new URLSearchParams({
    locationId,
    location_id: locationId,
    pipelineId,
    pipeline_id: pipelineId,
    contactId,
    contact_id: contactId,
    status: "open",
    limit: "20",
  });
  const res = await fetch(`${API_BASE}/opportunities/search?${params}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`búsqueda de oportunidades (${res.status}): ${(await res.text()).slice(0, 120)}`);
  const json = await res.json();
  const list = (json.opportunities ?? []) as OpportunityLite[];
  return list.filter(
    (o) =>
      (o.contactId ?? o.contact?.id) === contactId &&
      (!o.pipelineId || o.pipelineId === pipelineId) &&
      (!o.status || o.status === "open")
  );
}

export async function findOpenOpportunity(contactId: string): Promise<OpportunityLite | null> {
  return (await listOpenOpportunities(contactId))[0] ?? null;
}

export async function upsertOpportunity(contactId: string, opportunityName: string): Promise<UpsertResult> {
  const pipelineId = process.env.HIGHLEVEL_PIPELINE_ID;
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  if (!pipelineId) return { ok: false, message: "HIGHLEVEL_PIPELINE_ID no configurado: oportunidad omitida" };

  let existing: OpportunityLite | null = null;
  try {
    existing = await findOpenOpportunity(contactId);
  } catch (err) {
    // Sin poder buscar, NO creamos a ciegas (sería otro duplicado).
    return { ok: false, message: `Error HighLevel (buscar oportunidad): ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    // Ya hay una abierta: se actualiza (no se mueve de etapa ni se reabre nada).
    if (existing) {
      if (existing.name === opportunityName) return { ok: true, message: "Oportunidad ya existente (sin cambios)" };
      const res = await fetch(`${API_BASE}/opportunities/${existing.id}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ pipelineId, name: opportunityName }),
      });
      if (!res.ok) {
        const detail = await res.text();
        return { ok: false, message: `HighLevel ${res.status} (actualizar oportunidad): ${detail.slice(0, 160)}` };
      }
      return { ok: true, message: "Oportunidad existente actualizada en HighLevel" };
    }

    // No hay ninguna abierta: se crea.
    const body: Record<string, unknown> = {
      pipelineId,
      locationId,
      contactId,
      name: opportunityName,
      status: "open",
    };
    if (process.env.HIGHLEVEL_STAGE_ID) body.pipelineStageId = process.env.HIGHLEVEL_STAGE_ID;
    const res = await fetch(`${API_BASE}/opportunities/upsert`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { ok: false, message: `HighLevel ${res.status} (oportunidad): ${detail.slice(0, 160)}` };
    }
    return { ok: true, message: "Oportunidad creada en HighLevel" };
  } catch (err) {
    return { ok: false, message: `Error HighLevel (oportunidad): ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Orquestador: lo que llama guardar-lead.ts ---

// Un lead a la vez por teléfono: si el modelo llama dos veces seguidas a guardarLead,
// la segunda espera a la primera y encuentra lo ya creado en vez de duplicarlo.
const colas = new Map<string, Promise<unknown>>();

/**
 * Hace el flujo completo (contacto → etiqueta → oportunidad) en un único
 * paso, igual que upsertLead() en airtable.ts. Cada sub-paso captura sus
 * propios errores; un fallo en la etiqueta o la oportunidad NO deshace el
 * contacto ya guardado, y nunca lanza (throw) hacia quien la llama.
 */
export function upsertLead(phone: string, data: LeadData): Promise<UpsertResult> {
  const previa = colas.get(phone) ?? Promise.resolve();
  const actual = previa.then(() => upsertLeadSinCola(phone, data));
  const marca = actual.catch(() => undefined);
  colas.set(phone, marca);
  void marca.then(() => {
    if (colas.get(phone) === marca) colas.delete(phone);
  });
  return actual;
}

async function upsertLeadSinCola(phone: string, data: LeadData): Promise<UpsertResult> {
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
