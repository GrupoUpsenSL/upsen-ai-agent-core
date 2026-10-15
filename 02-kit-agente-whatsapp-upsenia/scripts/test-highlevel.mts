// Prueba REAL de la integración con HighLevel (contactos y oportunidades sin duplicados).
// Crea datos de prueba con teléfonos/emails ficticios, comprueba los casos y LIMPIA
// lo que ha creado al terminar. Usa las variables de .env.local (usa la sub-cuenta de
// pruebas, no una de cliente real).
// Uso: npx tsx scripts/test-highlevel.mts
import "./env-loader";

const hl: any = await import("../src/lib/highlevel");
const { upsertLead, searchContacts, listOpenOpportunities, samePhone, highlevelConfigured } = hl.default ?? hl;

if (!highlevelConfigured()) {
  console.error("Faltan HIGHLEVEL_API_KEY y HIGHLEVEL_LOCATION_ID en .env.local");
  process.exit(1);
}

const API = "https://services.leadconnectorhq.com";
const headers = {
  Authorization: `Bearer ${process.env.HIGHLEVEL_API_KEY}`,
  Version: "2021-07-28",
  Accept: "application/json",
  "Content-Type": "application/json",
};

const stamp = Date.now().toString().slice(-6);
const phoneA = `+3460${stamp.padStart(7, "0")}`.slice(0, 12); // ficticio
const phoneB = `+3461${stamp.padStart(7, "0")}`.slice(0, 12);
const emailA = `upsen.test.a${stamp}@example.com`;
const emailA2 = `upsen.test.a2${stamp}@example.com`;
const emailB = `upsen.test.b${stamp}@example.com`;

const creados = new Set<string>(); // ids de contactos a limpiar
let fallos = 0;
const check = (nombre: string, ok: boolean, extra = "") => {
  if (!ok) fallos++;
  console.log(`${ok ? "OK    " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
};

async function contactosPorTelefono(phone: string) {
  return (await searchContacts(phone)).filter((c: any) => samePhone(c.phone, phone));
}

try {
  // 1) Lead nuevo
  const r1 = await upsertLead(phoneA, { nombre: "Prueba Upsen", email: emailA });
  if (r1.contactId) creados.add(r1.contactId);
  const c1 = await contactosPorTelefono(phoneA);
  const o1 = r1.contactId ? await listOpenOpportunities(r1.contactId) : [];
  check("1. Lead nuevo: 1 contacto y 1 oportunidad", r1.ok && c1.length === 1 && o1.length === 1, r1.message);

  // 2) Misma llamada otra vez
  const r2 = await upsertLead(phoneA, { nombre: "Prueba Upsen", email: emailA });
  const c2 = await contactosPorTelefono(phoneA);
  const o2 = r1.contactId ? await listOpenOpportunities(r1.contactId) : [];
  check("2. Repetir: sigue 1 contacto y 1 oportunidad", r2.contactId === r1.contactId && c2.length === 1 && o2.length === 1, r2.message);

  // 3) Email corregido
  const r3 = await upsertLead(phoneA, { nombre: "Prueba Upsen", email: emailA2 });
  const c3 = await contactosPorTelefono(phoneA);
  const o3 = r1.contactId ? await listOpenOpportunities(r1.contactId) : [];
  check(
    "3. Email corregido: mismo contacto, email actualizado, 1 oportunidad",
    r3.contactId === r1.contactId && c3.length === 1 && c3[0]?.email?.toLowerCase() === emailA2 && o3.length === 1,
    r3.message
  );

  // 4) Tres llamadas simultáneas con un teléfono nuevo
  const rs = await Promise.all([
    upsertLead(phoneB, { nombre: "Prueba B", email: emailB }),
    upsertLead(phoneB, { nombre: "Prueba B", email: emailB }),
    upsertLead(phoneB, { nombre: "Prueba B", email: emailB }),
  ]);
  for (const r of rs) if (r.contactId) creados.add(r.contactId);
  const cB = await contactosPorTelefono(phoneB);
  const oB = rs[0].contactId ? await listOpenOpportunities(rs[0].contactId) : [];
  check("4. Tres llamadas simultáneas: 1 contacto y 1 oportunidad", cB.length === 1 && oB.length === 1, `contactos=${cB.length} oportunidades=${oB.length}`);
} catch (err) {
  fallos++;
  console.error("ERROR en la prueba:", err instanceof Error ? err.message : err);
} finally {
  // Limpieza: solo los contactos creados en esta ejecución (y sus oportunidades abiertas).
  for (const id of creados) {
    try {
      for (const o of await listOpenOpportunities(id)) {
        await fetch(`${API}/opportunities/${o.id}`, { method: "DELETE", headers });
      }
      await fetch(`${API}/contacts/${id}`, { method: "DELETE", headers });
    } catch {
      console.warn(`No pude limpiar el contacto ${id}: bórralo a mano en HighLevel.`);
    }
  }
  console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTodas las pruebas OK. Datos de prueba eliminados.");
  process.exit(fallos ? 1 : 0);
}
