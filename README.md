## Despliegue en producción

### a. URLs de producción

| Instancia | URL |
|---|---|
| ClinicBot | https://clinicbot2.upsenai.com |
| UPSEN AI | https://agent.upsenai.com |

> **Nota:** ClinicBot usa el subdominio `clinicbot2` (no `clinicbot`) porque
> `clinicbot.upsenai.com` ya estaba ocupado por un proyecto EasyPanel
> anterior (stack de n8n + Evolution API) corriendo en el mismo servidor.
> Pendiente de decidir con el equipo si ese stack antiguo se retira para
> liberar el subdominio original.

### b. Variables de entorno necesarias por instancia

Cada instancia necesita su propio `.env.local` (nunca subido al repositorio)
con estas variables. Ver `.env.example` para el formato exacto de cada una.

**Motor del agente:**
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `AGENT_CONFIG` — determina qué `prompts/negocio.<valor>.md` se carga
- `PORT` — puerto interno del contenedor (ver sección de despliegue, punto 6)
- `TRANSCRIPTION_MODEL`
- `VISION_MODEL`
- `BUFFER_SECONDS`
- `LOG_LEVEL`

**CRM — Airtable (opcional):**
- `AIRTABLE_API_KEY`
- `AIRTABLE_BASE_ID`
- `AIRTABLE_LEADS_TABLE`
- `AIRTABLE_AGENT_UTM`

**CRM — HighLevel:**
- `HIGHLEVEL_API_KEY`
- `HIGHLEVEL_LOCATION_ID`
- `HIGHLEVEL_PIPELINE_ID`
- `HIGHLEVEL_STAGE_ID`
- `HIGHLEVEL_LEAD_TAG`

**Memoria de largo plazo — Supabase (opcional):**
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

**Guardrails (específicos de cada negocio):**
- `ALLOWED_PRICES`
- `ALLOWED_HOSTS`
- `CHECKOUT_URL`
- `SECURITY_CANARY`
- `GUARD_FALLBACK_MSG`

**Otros:**
- `CAL_BOOKING_URL`
- `ALERT_WHATSAPP`

### c. Desplegar una nueva instancia en EasyPanel

1. En tu máquina local, borra el fichero `tsconfig.tsbuildinfo` de la raíz
   del proyecto si existe (`rm -f tsconfig.tsbuildinfo`) — si se incluye en
   el zip, rompe el build de Nixpacks con un error de montaje de caché.
2. Comprime el proyecto excluyendo `node_modules`, `.next`, `data/`, `auth/`
   y `tsconfig.tsbuildinfo`:
```bash
   zip -r nombre-instancia.zip . -x "node_modules/*" -x ".next/*" \
     -x "data/*" -x "auth/*" -x "tsconfig.tsbuildinfo"
```
3. En EasyPanel: **New Service → App**, nómbralo según el cliente.
4. En **Source**, elige **Upload** y sube el zip. En **Build**, confirma que
   detecta **Nixpacks** (usa el `nixpacks.toml` ya incluido en el repo) y
   deja los campos de comandos en blanco.
5. En **Environment**, añade todas las variables de la sección (b) con los
   valores reales de este cliente — especialmente `AGENT_CONFIG` (debe
   coincidir con el nombre de `prompts/negocio.<valor>.md`) y
   `HIGHLEVEL_PIPELINE_ID`/`HIGHLEVEL_LEAD_TAG` propios, nunca reutilizados
   de otra instancia.
6. En **Mounts**, añade volúmenes persistentes para `/app/data` y
   `/app/auth` — sin esto, el historial de conversaciones y la sesión de
   WhatsApp se pierden en cada redeploy (los contenedores son efímeros).
7. En **Domains**, añade el subdominio de este cliente con destino
   **HTTP, puerto 3000** (cada contenedor está aislado, así que reutilizar
   el mismo puerto interno en varias instancias no genera conflicto).
   EasyPanel provisiona el certificado SSL automáticamente.
8. Despliega. Antes de probarlo, confirma con `nslookup <subdominio>` que
   el DNS ya resuelve a la IP del VPS.

### d. Estructura de carpetas (resumen)
02-kit-agente-whatsapp/
├── src/
│ ├── app/ # Dashboard Next.js + rutas API (incluye /api/widget)
│ └── lib/
│ ├── baileys/ # Conexión y manejo de mensajes de WhatsApp
│ ├── tools/ # Herramientas del agente (guardarLead, etc.)
│ ├── openrouter.ts # Llamada al LLM
│ ├── system-prompt.ts # Construcción del prompt (usa AGENT_CONFIG)
│ ├── guardrails.ts # Filtros de entrada/salida
│ ├── highlevel.ts # Conector CRM HighLevel
│ └── airtable.ts # Conector CRM Airtable
├── prompts/
│ └── negocio.<config>.md # Un fichero de negocio por cliente/instancia
├── public/
│ ├── widget.js # Widget de chat embebible (genérico, sin cambios entre instancias)
│ └── demo.html # Página de demo (personalizada por instancia)
├── data/ # Base de datos SQLite (requiere volumen persistente)
├── auth/ # Sesión de WhatsApp/Baileys (requiere volumen persistente)
└── .env.local # Config de ESTA instancia (nunca en el repo)

Cada instancia (ClinicBot, UPSEN AI, o cualquier cliente futuro) es una
copia independiente de esta misma estructura, diferenciada únicamente por
su `.env.local`, su `prompts/negocio.<config>.md` y sus volúmenes de datos.