
### Configuración de cliente (cambia por cliente)
- `AGENT_CONFIG` — identifica la instancia (ej. `clinicbot`, `upsen`)
- Archivos en `/prompts/` — instrucciones y personalidad del agente
- Archivo `negocio.md` — Knowledge Base con información del negocio
- Variables de entorno del CRM (pipeline, etiquetas, campos)
- Subdominio y branding

---

## Cómo crear una nueva instancia para un cliente

Sigue estos pasos para adaptar el sistema a un nuevo cliente sin modificar el núcleo:

### 1. Duplicar la configuración base

Copia el archivo `.env.example` y renómbralo `.env.local`. Rellena todas las variables con los datos del nuevo cliente.

### 2. Configurar la identidad del agente

Establece `AGENT_CONFIG=nombre_cliente` en las variables de entorno. Este valor identifica la instancia dentro del sistema.

### 3. Preparar la Knowledge Base

Crea o edita el archivo `negocio.md` con la información del negocio:
- Nombre y descripción de la empresa
- Servicios y precios
- Preguntas frecuentes
- Horarios y datos de contacto
- Tono y personalidad del agente
- Reglas de derivación a humano

### 4. Configurar HighLevel

En la cuenta de HighLevel del cliente:
- Crear pipeline con las etapas correspondientes
- Crear campos personalizados (nombre, email, teléfono, necesidad)
- Configurar etiquetas de cualificación
- Copiar los IDs necesarios a las variables de entorno (`HIGHLEVEL_PIPELINE_ID`, `HIGHLEVEL_STAGE_ID`, etc.)
- Crear workflows para nuevo lead, lead cualificado y derivación a humano

### 5. Desplegar en EasyPanel

Ver sección **Despliegue en producción** más abajo.

### 6. Probar antes de publicar

Realiza al menos estas pruebas antes de dar el agente por operativo:
- El agente responde solo en español
- Usa únicamente la información de `negocio.md`
- No inventa precios ni datos
- Captura nombre, email, teléfono y necesidad correctamente
- El contacto aparece en HighLevel con los campos y etiquetas correctas
- El workflow se activa al llegar un nuevo lead
- El agente responde correctamente cuando no sabe algo

---

## Despliegue en producción

### Variables de entorno necesarias por instancia

Cada instancia necesita su propio `.env.local` (nunca subido al repositorio).
Ver `.env.example` para el formato exacto.

**Motor del agente:**
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `AGENT_CONFIG`
- `PORT`
- `TRANSCRIPTION_MODEL`
- `VISION_MODEL`
- `BUFFER_SECONDS`
- `LOG_LEVEL`

**CRM — HighLevel:**
- `HIGHLEVEL_API_KEY`
- `HIGHLEVEL_LOCATION_ID`
- `HIGHLEVEL_PIPELINE_ID`
- `HIGHLEVEL_STAGE_ID`
- `HIGHLEVEL_LEAD_TAG`

**CRM — Airtable (opcional):**
- `AIRTABLE_API_KEY`
- `AIRTABLE_BASE_ID`
- `AIRTABLE_LEADS_TABLE`
- `AIRTABLE_AGENT_UTM`

**Memoria de largo plazo — Supabase (opcional):**
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

**Guardrails:**
- `ALLOWED_PRICES`
- `ALLOWED_HOSTS`
- `CHECKOUT_URL`
- `SECURITY_CANARY`
- `GUARD_FALLBACK_MSG`

**Otros:**
- `CAL_BOOKING_URL`
- `ALERT_WHATSAPP`

### Pasos para desplegar una nueva instancia en EasyPanel

1. Elimina `tsconfig.tsbuildinfo` localmente si existe
2. Comprime el proyecto excluyendo `node_modules`, `.next`, `auth` y `.env.local`
3. Crea un nuevo servicio en EasyPanel dentro del proyecto `upsen-agents`
4. Sube el zip y confirma que Nixpacks detecta el proyecto correctamente
5. Añade todas las variables de entorno con los valores del cliente
6. Añade volúmenes persistentes para `/app/data` y `/app/auth`
7. Configura el dominio con el subdominio del cliente apuntando al puerto HTTP 3000
8. Despliega y verifica que el DNS resuelve correctamente

---

## Estructura del repositorio

/
├── src/ # Código fuente del agente (Next.js)
├── prompts/ # Instrucciones del agente por instancia
├── public/ # Archivos estáticos (demo web)
├── data/ # Datos persistentes (volumen en producción)
├── auth/ # Sesión WhatsApp (volumen en producción)
├── .env.example # Plantilla de variables de entorno
└── negocio.md # Knowledge Base del cliente activo


---

## Desarrollado por

[UPSEN](https://upsenai.com) — Agentes IA para empresas  
Contacto: hola@upsenai.com
