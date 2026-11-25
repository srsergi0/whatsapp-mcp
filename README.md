# whatsapp-mcp

Servidor **MCP** para WhatsApp basado en [Baileys](https://github.com/WhiskeySockets/Baileys) (`baileys@7.0.0-rc14`), con **vinculación por código de emparejamiento (sin QR)**, multi-sesión y **persistencia completa en SQLite**.

- 71 tools: sesiones, envío (texto, media, voz, stickers, ubicación, contactos, encuestas, eventos, estados), lectura/búsqueda, contactos, chats, grupos, canales, Business, memoria y administración.
- Todo lo que llega (mensajes, historial, reacciones, votos de encuestas, grupos, llamadas) se guarda en `data/whatsapp.db`; el agente lee de ahí, así que funciona aunque el teléfono esté apagado y sobrevive a reinicios.
- Credenciales de Baileys también en SQLite (transaccional; sin miles de `.json` sueltos).

## Instalación

```bash
npm install
npm run build
npm test            # 41 tests: unitarios, ingesta de eventos, envío, e2e stdio y HTTP
```

¿Sin nada instalado y con un agente que lo haga por ti? Pégale el prompt de [INSTALL_PROMPT.md](INSTALL_PROMPT.md): comprueba Node, clona, compila, registra el MCP y vincula tu número.

Requisitos: Node ≥ 22.13 (usa `node:sqlite` con FTS5, sin compilar nada nativo). `ffmpeg` en el PATH es opcional (notas de voz y stickers animados).

## Vincular tu número (código de emparejamiento)

Opción A – desde la terminal (con el servidor MCP detenido):

```bash
npm run pair -- --phone 5491112345678 --session personal
```

Opción B – desde el cliente MCP: pide *"vincula mi WhatsApp 5491112345678"* (tool `session_pair`, o el prompt `link_whatsapp`).

Te devuelve un código de 8 caracteres. En el teléfono: **WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo → "Vincular con el número de teléfono"** y escribe el código. Luego `session_status {wait_seconds: 60}` confirma que la sesión quedó `open`. A partir de ahí se reconecta sola al arrancar.

## Conectarlo a un cliente MCP

**Claude Code** (alcance usuario):

```bash
claude mcp add whatsapp -- node /ruta/a/whatsapp-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/ruta/a/whatsapp-mcp/dist/index.js"],
      "env": { "WA_MCP_TOOLSETS": "lite" }
    }
  }
}
```

El repo trae `.mcp.json` para Claude Code abierto en esta carpeta.

### Varias ventanas / clientes a la vez

WhatsApp solo admite **una conexión por sesión**, pero cada cliente MCP lanza su propio proceso. Por eso hay un *dueño* único (`data/server.lock`):

- El primer proceso es el **dueño**: abre WhatsApp y publica un puente HTTP solo-localhost con token aleatorio.
- Los demás procesos stdio detectan el puente y funcionan como **proxy transparente**: mismas tools, mismos datos en vivo, mismas notificaciones. Nada que configurar.
- Si el cliente del dueño se cierra, el proceso sigue vivo mientras queden clientes conectados a través de él (si el cliente lo mata a la fuerza, los demás deben reconectar y uno pasa a ser el nuevo dueño).
- Un dueño de una versión antigua (sin puente) deja a los nuevos en modo *pasivo* (solo lectura, lo indica `server_info`): reiníciala.

**Recomendado si usas muchas ventanas:** arranca un demonio una vez (Inicio de Windows, Programador de tareas, pm2…) y deja tus clientes tal cual; todos harán de proxy al demonio, que no depende de ninguna ventana.

```bash
npm run start:http        # http://127.0.0.1:3939/mcp  (Authorization: Bearer <token>)
```

El token fijo del modo HTTP está en `data/http-token` (o `WA_MCP_HTTP_TOKEN`). También puedes apuntar un cliente directamente a esa URL con `Authorization: Bearer …`. Solo escucha en localhost por defecto y valida `Host` (anti DNS-rebinding).

## Qué hay dentro

| Grupo (`WA_MCP_TOOLSETS`) | Tools |
|---|---|
| `sessions` | `session_list` `session_pair` `session_status` `session_control` `session_logout` `session_delete` `profile_update` `privacy_settings` `account_health` `configure_health_guard` |
| `messages` | `send_text` `send_media` (image/video/audio/voice/document/sticker) `send_location` `send_contacts` `send_poll` `send_event` `react_to_message` `edit_message` `delete_message` `forward_message` `pin_message` `set_presence` `mark_read` `schedule_message` `broadcast_message` `list_scheduled` `cancel_scheduled` `post_status` |
| `read` | **`inbox`** (no leídos + chats que esperan TU respuesta) **`follow_ups`** (chats que esperan SU respuesta) `inbox_dismiss` `list_chats` `get_chat` `get_messages` `get_message` `search_messages` (FTS5) `unread_summary` `load_older_history` `download_media` `get_events` (long-poll) `get_poll_results` |
| `contacts` | `find_contacts` `check_numbers` `get_profile_picture` `get_about` `get_presence` `block_contact` `get_blocklist` `save_contact` `remove_contact` |
| `chats` | `chat_action` (archivar, fijar, silenciar, no leído, destacar, temporales, vaciar, borrar) `labels` |
| `groups` | `list_groups` `group_info` `create_group` `group_update` `group_participants` `group_invite` `group_join_requests` `leave_group` |
| `business` | `get_business_profile` `catalog` `product_manage` `order_details` `channel` |
| `memory` | `chat_memory` (datos estables) `log_interaction` `list_interactions` `update_interaction` (línea de tiempo y pendientes) `chat_tags` `ignore_list` |
| `admin` | `server_info` `audit_log` `export_chat` `db_maintenance` (backup, vacuum…) |

`WA_MCP_TOOLSETS=lite` expone solo `sessions,messages,read,contacts,groups,memory` (menos contexto). `WA_MCP_READ_ONLY=1` (o `--read-only`) oculta las 32 tools que envían o cambian WhatsApp.

### Bandeja: nuevos, no leídos y sin responder

`inbox` responde "¿qué necesita mi atención?" con una sola llamada:

- `filter`: `unread` (tienen mensajes sin leer), `unanswered` (el último mensaje real es suyo y tú no has respondido) o `any` (por defecto).
- Cada chat trae cuánto lleva esperando (`waiting: "3h 12m"`), desde cuándo, cuántos mensajes pendientes, si parece una pregunta y los últimos mensajes.
- En grupos solo cuenta lo que te **menciona** o **responde a un mensaje tuyo**; omite silenciados, archivados y bloqueados.
- Filtros: `min_wait_minutes`, `max_age_days` (14), `include_groups`, `messages_per_chat`, `sort`.
- `inbox_dismiss {chat}` oculta un chat que no necesita respuesta hasta que vuelva a escribir.
- También como resource suscribible `whatsapp://{session}/inbox` y en los prompts `triage_inbox` / `unanswered_followups`.

Ejemplos: *"¿qué mensajes tengo sin responder de más de 2 horas?"* → `inbox {filter:"unanswered", min_wait_minutes:120}`.

### Seguimiento: clientes que no responden

`follow_ups` es lo contrario de `inbox`: chats donde **tu** mensaje es el último y la otra persona no ha contestado.

- `stage` de cada chat: `proposal_sent` (le enviaste un documento), `engaged` (hubo conversación), `cold` (solo su primer "quiero más información").
- `attempts`: cuántos seguimientos ya hiciste desde su último mensaje (mensajes con menos de 6 h entre sí cuentan como uno). Con `max_attempts` (3) se ocultan los que ya perseguiste demasiado.
- También muestra si vio tu último mensaje (✓✓), cuánto lleva en silencio, tus notas/tareas abiertas y los últimos mensajes.
- Omite chats donde registraste una llamada o reunión después de tu último mensaje, y los que tienen la etiqueta `no-followup` (`chat_tags`).
- Filtros: `min_silence_hours` (20), `max_age_days` (30), `include_never_replied`, `sort` (`priority`: primero propuestas y conversaciones, luego fríos).
- Prompt `recover_leads`: redacta un seguimiento por chat según su etapa y espera tu aprobación.

Ejemplo: *"recupera los clientes que no respondieron"* → `follow_ups {}`.

### Ahorro de tokens al leer

- **Formato compacto y modo digest:** `get_messages` soporta `format: "compact"` (por defecto, ~65% menos tokens), `format: "json"` (estructura completa) y **`format: "digest"`** (resumen ejecutivo de alta densidad: extrae archivos y documentos adjuntos con sus IDs, tareas/pendientes y el intercambio reciente, ahorrando hasta un **80% de tokens** en historiales largos).
- **Descarga directa al workspace:** `download_media` acepta `destination_dir` (ej. `./addons/` o ruta del proyecto) y `destination_file`, copiando automáticamente el archivo adjunto descargado al directorio destino del agente con validación de seguridad contra rutas protegidas.
- **Suscripciones MCP en tiempo real (`resources/subscribe`):** Soporta el estándar oficial de MCP para recursos dinámicos. Clientes como Paseo, Claude o Codex pueden suscribirse a `whatsapp://events/latest`, `whatsapp://{session}/events` o `whatsapp://{session}/chat/{jid}/stream` y recibir notificaciones push instantáneas (`resources/updated`) cada vez que entra un mensaje o evento.
- **IDs cortos:** cada mensaje termina en `#` + últimos 8 caracteres. Cualquier herramienta que reciba `message_id`, `quoted_id`, `poll_id` o `after_message_id` los acepta (también con 5-16 caracteres si son únicos).
- **Lectura incremental:** `get_messages {chat, unseen_only:true}` devuelve solo lo posterior a lo que ese cliente ya leyó del chat (en ambas direcciones); sin novedades responde en una línea. `after_message_id` hace lo mismo desde un mensaje concreto. `inbox {skip_seen:true}` no repite mensajes ya mostrados.
- La respuesta compacta lleva como `structuredContent` solo metadatos mínimos (conteo, cursor), no el texto duplicado.

### Guardia de frescura: nunca responder a una conversación que cambió

Mientras el LLM analiza qué contestar, el cliente puede escribir algo nuevo. Por eso el servidor (no el LLM) lo impone:

- Cada lectura (`get_messages`, `inbox`, `get_message`, `get_events`, `unread_summary`, transcripción) marca hasta dónde ha visto ese cliente cada chat.
- Todo envío (`send_text`, `send_media`, `send_poll`, `forward_message`…) comprueba si llegó algo **nuevo del otro lado** desde esa marca. Si sí, **no se envía**: devuelve `NOT SENT` con los mensajes nuevos. Esos mensajes quedan marcados como vistos, así que si la respuesta sigue siendo válida basta repetir la llamada.
- Si el chat nunca se leyó en esta conexión, se bloquea cuando hay mensajes suyos posteriores a tu última respuesta o llamada (sería responder a ciegas). En grupos solo se exige tras haberlos leído.
- Se vuelve a comprobar **justo antes de enviar**, después de la pausa antiban, para cubrir mensajes que lleguen en esos instantes.
- Los `schedule_message` quedan **retenidos** (`held`) si el chat cambió después de programarlos; `list_scheduled` los muestra y `cancel_scheduled {id, release:true}` los envía igualmente.
- Se puede saltar con `ignore_new_messages: true` (solo si el usuario lo pide) o desactivar con `WA_MCP_FRESHNESS_GUARD=0`.

Limitación: solo ve los mensajes que ya llegaron a este servidor; uno que aún esté en tránsito por la red de WhatsApp no se puede detectar.

### Difusión Segura con Jitter Anti-Ban (`broadcast_message`)

Envía o encola mensajes masivos personalizados a múltiples destinatarios protegiendo la cuenta contra bloqueos y baneos por parte de Meta:

- **Jitter Aleatorio Anti-Ban**: Delays variables y aleatorios entre cada envío (por defecto entre 15 y 35 segundos, configurable mediante `min_delay_seconds` y `max_delay_seconds`).
- **Pausa por Lotes (*Batch Cooldown*)**: Tras cada bloque de `batch_size` mensajes (por defecto 5), introduce automáticamente un descanso extendido de `cooldown_seconds` (por defecto 60s) para emular el comportamiento humano.
- **Variables Dinámicas de Contacto**: Soporta plantillas con interpolación automática desde la libreta de contactos local:
  - `{{name}}`: Nombre completo del contacto o chat (o `"Cliente"` si no se conoce).
  - `{{first_name}}`: Primer nombre del destinatario.
  - `{{phone}}`: Número de teléfono limpio.
  - `{{variable}}`: Variables arbitrarias pasadas en el parámetro `variables: { "<phone_or_name>": { "saldo": "S/ 120", "vence": "28/11" } }`.
- **Modo Simulación (`dry_run: true`)**: Permite previsualizar la lista procesada, detectar duplicados omitidos, destinatarios inválidos, variables no suministradas y el cronograma exacto estimado de envíos antes de tocar la base de datos.
- **Persistencia y Resiliencia**: Los mensajes se programan de forma duradera en SQLite (`scheduled_messages`) asociados a un `broadcast_id` y `tag` opcional. Si el servidor se apaga o reinicia, la campaña continúa su curso sin duplicar envíos.
- **Cancelación y Gestión por Lote**: Con `cancel_scheduled { broadcast_id }` o `cancel_scheduled { tag }` es posible cancelar una campaña completa con una sola llamada.
- **Filtro en Listado**: `list_scheduled` permite filtrar mensajes programados por `tag` o `broadcast_id`.

### Guardián de Salud de Cuenta y Circuit Breaker (`account_health`)

Protege la cuenta contra el algoritmo de baneo y suspensión de Meta mediante una ventana deslizante de métricas en tiempo real y corte automático de emergencia:

- **Los 3 Pilares del Algoritmo de Meta (Investigados a Fondo)**:
  1. *Outreach Frío vs. Simetría Inbound*: Enviar mensajes a números que no te tienen guardado ni han hablado antes sin el token de privacidad (`tctoken`) activa el **Error 463 (*Reachout Timelocked*)**. Además, cuentas con más del 80% de tráfico saliente unilateral acumulan puntaje de riesgo de bot.
  2. *Tasa de Reporte y Bloqueo (*User Friction*)*: Cuando un destinatario frío presiona "Reportar Spam" o "Bloquear", WhatsApp envía un recibo de telemetría silencioso. Si la tasa de bloqueo supera entre el **3% y el 5%** en 24h, el sistema de Meta aplica suspensión automática.
  3. *Velocidad y Ráfagas*: Disparar más de 25-35 mensajes fríos por hora activa disparadores heurísticos de spam.
- **Puntuación de Riesgo Dinámica (0 - 100)**: Evalúa velocidad en 1h, volumen en 24h, asimetría de tráfico y otorga crédito de recuperación por cada mensaje entrante de clientes legítimos.
- **Circuit Breaker Anti-Suspensión**:
  - Si el score supera 85 o se alcanza el límite horario (`max_cold_per_hour`, por defecto 25): **se dispara el Circuit Breaker**.
  - **Bloquea envíos a números fríos (desconocidos)** durante el tiempo de enfriamiento (`cooldown_minutes`, por defecto 45m).
  - **Permite responder a clientes existentes** que te escriban (atender chats entrantes reduce el riesgo y restaura la salud de la cuenta).
  - Captura automática de `Error 463`: si Meta responde con reachout timelock, el breaker salta de inmediato protegiendo el socket.
- **Herramientas**:
  - `account_health`: Muestra el semáforo de salud, métricas de 1h y 24h, estado del circuit breaker y diagnóstico detallado de las heurísticas de Meta.
  - `configure_health_guard`: Permite ajustar umbrales (`max_cold_per_hour`, `cooldown_minutes`) o resetear manualmente el breaker (`reset_circuit_breaker: true`).

### Línea de tiempo: lo que haces *fuera* del chat

Si alguien escribe "llámame" y lo llamas por teléfono, el chat seguiría pareciendo "pendiente". Para eso existe la línea de tiempo persistente:

- `log_interaction {chat, kind, note}`: guarda qué pasó. `kind`: `call` · `meeting` · `handled` (resuelto por otra vía) · `note` · `task` (pendiente/promesa, con `due` opcional).
- `call`/`meeting`/`handled` cuentan como respuesta: el chat sale de "sin responder" hasta que la persona escriba de nuevo. `when:"15m"` registra que fue hace 15 minutos.
- Lo guardado aparece solo como `my_notes` en `inbox`, `get_messages` y `get_chat`, y entrelazado (`★ CALL …`) en el resource de transcripción, así el LLM lo tiene en cuenta antes de sugerir una respuesta.
- `list_interactions {status:"open"}` lista tus pendientes (con `overdue_only`), `update_interaction` los completa/edita/borra. `inbox` avisa de las tareas que vencen pronto.
- Se diferencia de `chat_memory` (datos estables: idioma, preferencias) en que es una cronología con fechas.

Ejemplo: *"Ana me escribió 'llámame' y ya la llamé, quedamos en enviar la cotización mañana"* → `log_interaction {chat:"Ana", kind:"call", note:"…"}` + `log_interaction {kind:"task", note:"Enviar cotización", due:"+1d"}`.

### Esperando su respuesta

Cuando le enviaste algo y **tú** esperas contestación (una propuesta, una pregunta, una cotización):

- **Registrarlo al enviar:** cualquier herramienta de envío acepta `wait_for_reply:"+2d"` (también `"+3h"` o una fecha ISO). O después: `log_interaction {chat, kind:"waiting", note, due}` (si no das `due`, 2 días).
- **Se cierra solo:** en cuanto esa persona escribe algo (no cuentan sus mensajes anteriores ni los tuyos) la espera pasa a `replied`, queda enlazada con el mensaje que la cerró y se publica el evento `waiting.replied`.
- **Si no contesta:** `inbox` la muestra en **"I WAIT FOR THEIR REPLY"** con el tiempo que llevas esperando y `OVERDUE` cuando pasa la fecha, y el servidor emite una sola vez el evento `waiting.overdue` (visible en `get_events` y como notificación de log MCP).
- **Vista de listas:** `inbox` separa lo que **te** esperan a ti (`THEY WAIT …`), lo que **tú** esperas de ellos y tus pendientes propios (`TASKS DUE SOON`). `list_interactions {kind:"waiting", status:"open"}` lista las esperas abiertas; `update_interaction {id, action:"complete"}` deja de esperar a mano.
- **Sin fecha ni registro:** `follow_ups` sigue listando todos los chats donde tu mensaje es el último y no han respondido.
- En grupos cuenta cualquier mensaje entrante del grupo como respuesta.

### Funciones MCP modernas que usa

- **Structured output** (`outputSchema` + `structuredContent`) además del texto JSON.
- **Tool annotations**: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` en cada tool.
- **Resources + plantillas + subscripciones** (`whatsapp://{session}/chat/{jid}/messages`, `/inbox`, `/unread`, `/status`, `/media/…`); recibes `notifications/resources/updated` cuando entra un mensaje. Con *completions* de sesión y chat.
- **Resource links** e **imágenes/audio inline** en `download_media`, `get_profile_picture`.
- **Prompts**: `link_whatsapp`, `triage_inbox`, `summarize_chat`, `draft_reply`, `unanswered_followups`, `group_digest`, `whatsapp_daily_report`.
- **Elicitation**: las acciones irreversibles (`session_logout`, `delete_message`, `chat_action delete/clear`, `leave_group`, quitar miembros…) piden confirmación al usuario; si el cliente no soporta elicitation exigen `confirm: true`.
- **Logging y progress notifications**; **Streamable HTTP** con bearer token.
- **Claude Code channels** (experimental, `WA_MCP_CHANNEL=1` + `WA_MCP_CHANNEL_ALLOW=<números>`): empuja los mensajes entrantes de números permitidos a la conversación.

## Persistencia (`data/`)

```
data/whatsapp.db      credenciales, sesiones, chats, contactos, mensajes (+ FTS5), reacciones, votos,
                      grupos, etiquetas, llamadas, notas/tags, ignore-list, mensajes programados,
                      journal de eventos (get_events con since_id sobrevive a reinicios), auditoría
data/media/           adjuntos descargados (auto, ≤ WA_MCP_MEDIA_MAX_MB)
data/exports/         export_chat
data/backups/         db_maintenance backup  (contiene credenciales)
data/logs/            logs pino (stderr solo warn+; stdout reservado al protocolo)
```

LID ↔ número: Baileys 7 usa identificadores `@lid`; el servidor aprende la equivalencia y unifica los chats bajo el JID de teléfono.

## Seguridad y antiban

- El **contenido de los mensajes recibidos es dato no confiable** (riesgo de *prompt injection*): las instrucciones del servidor y los prompts lo indican; ninguna tool ejecuta nada por lo que diga un mensaje.
- Envíos: cola serializada, `WA_MCP_SEND_DELAY_MS` (700 ms) y tope `WA_MCP_MAX_MSGS_PER_MIN` (40) por sesión. Los destinatarios por nombre exigen coincidencia **exacta** y única.
- Archivos locales: se rechaza `data/` (credenciales), `.ssh`, `.env`, `*.pem`, `id_rsa`… ; restringible con `WA_MCP_ALLOWED_DIRS`. Descargas por URL: http(s), límite de tamaño y bloqueo de IPs privadas/loopback (SSRF).
- `data/` contiene la sesión de WhatsApp en claro: no la subas a git (ya está en `.gitignore`).
- Baileys es una librería **no oficial**: úsala con tu propia cuenta y sin spam; WhatsApp puede restringir cuentas que automatizan en exceso.

## Variables de entorno

Ver [.env.example](.env.example). Las más útiles: `WA_MCP_DATA_DIR`, `WA_MCP_READ_ONLY`, `WA_MCP_TOOLSETS`, `WA_MCP_AUTO_DOWNLOAD`, `WA_MCP_MAX_MSGS_PER_MIN`, `WA_MCP_HTTP_*`.

## Notas y límites conocidos

- Verificado automáticamente: esquema SQLite, ingesta de eventos Baileys simulados, construcción de mensajes, protocolo MCP por stdio y HTTP, y la conexión real con los servidores de WhatsApp hasta el punto de pedir el código. **El emparejamiento con tu teléfono y los envíos reales deben probarse una vez con tu número.**
- `browser: Mac OS / Chrome` con `syncFullHistory`: la combinación `Desktop` es rechazada (428) por el servidor y no se usa. La cantidad de historial inicial la decide WhatsApp; `load_older_history` pide más bajo demanda.
- Comunidades, llamadas salientes y la API oficial de Business Cloud no están cubiertas.
- Depuración: `npm run inspect` abre el MCP Inspector; logs en `data/logs/`.
