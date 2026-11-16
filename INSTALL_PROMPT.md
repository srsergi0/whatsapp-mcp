# Instalar whatsapp-mcp con un agente

Copia el bloque de abajo y pégalo en tu agente (Claude Code, Claude Desktop con acceso a terminal, Cursor, etc.).
No necesitas tener nada instalado: el agente lo comprueba y te pide permiso antes de instalar algo.

---

```text
Quiero instalar el servidor MCP de WhatsApp de https://github.com/srsergi0/whatsapp-mcp y dejarlo conectado a mi cliente MCP. Hazlo tú por terminal, paso a paso, y dime en una línea qué haces antes de cada paso. Responde en mi idioma.

REGLAS
- Antes de instalar software del sistema (Node.js, Git) pídeme confirmación. Todo lo demás hazlo sin preguntar.
- No toques ninguna carpeta `data/` existente ni borres nada. Si ya existe una instalación de whatsapp-mcp en el destino, actualízala con `git pull` y `npm install` en vez de clonar de nuevo.
- No envíes ningún mensaje de WhatsApp de prueba. Solo vincula el número cuando yo te lo dé.
- Nunca dejes dos procesos de whatsapp-mcp conectados a la misma sesión a la vez: WhatsApp cierra la sesión. Para verificar, usa el cliente MCP, no lances el servidor a mano si ya hay uno corriendo.
- Si un paso falla, muéstrame el error exacto y propón el arreglo; no inventes que funcionó.

PASOS
1. Detecta mi sistema operativo y mi cliente MCP (Claude Code, Claude Desktop u otro). Si no puedes saberlo, pregúntame.
2. Node.js: ejecuta `node --version`. Necesito 22.13 o superior. Si falta o es menor, propónme instalar la versión LTS:
   - Windows: `winget install OpenJS.NodeJS.LTS`
   - macOS: `brew install node`
   - Linux: el gestor de paquetes de mi distro (o nvm) con Node 22+
   Después cierra y abre la terminal si hace falta y confirma `node --version` y `npm --version`.
3. Git: ejecuta `git --version`. Si falta, propónme instalarlo (Windows: `winget install Git.Git`). Si no quiero Git, descarga el ZIP de https://github.com/srsergi0/whatsapp-mcp/archive/refs/heads/main.zip y descomprímelo.
4. Descarga e instala:
   - Clona en `~/mcp-servers/whatsapp-mcp` (en Windows `%USERPROFILE%\mcp-servers\whatsapp-mcp`).
   - Dentro de esa carpeta ejecuta `npm install`. Esto también compila el proyecto (script `prepare`).
   - Comprueba que existe `dist/index.js`. Guarda su RUTA ABSOLUTA.
5. Regístralo en mi cliente MCP usando esa ruta absoluta:
   - Claude Code: `claude mcp add --scope user whatsapp -- node <RUTA_ABSOLUTA>/dist/index.js`
   - Claude Desktop: edita `claude_desktop_config.json` AÑADIENDO la entrada `whatsapp` dentro de `mcpServers` sin borrar las que ya haya: `{"command": "node", "args": ["<RUTA_ABSOLUTA>/dist/index.js"]}`. Haz una copia de seguridad del archivo antes.
   - Otro cliente: muéstrame el bloque JSON equivalente para que lo pegue.
   Opcional: si quiero menos herramientas en el contexto, añade `"env": {"WA_MCP_TOOLSETS": "lite"}`.
6. Dime que reinicie el cliente (o que recargue los MCP) para que cargue el servidor, y espera a que te avise. Después comprueba que las herramientas `session_list` y `session_status` aparecen y responden.
7. Vincular mi número, sin QR: pídeme mi número con código de país, solo dígitos (ejemplo 5491112345678). Llama a la herramienta `session_pair` con ese número. Muéstrame el código de 8 caracteres y dime exactamente: en el teléfono, WhatsApp > Ajustes > Dispositivos vinculados > Vincular un dispositivo > "Vincular con el número de teléfono" y escribir el código. Luego llama a `session_status` con `wait_seconds: 60` hasta que el estado sea `open`.
8. Termina con un resumen corto: versión de Node, carpeta de instalación, cómo quedó registrado, estado de la sesión, y qué puedo pedirte ahora (por ejemplo "¿qué mensajes tengo pendientes de responder?").
```

---

## Versión corta

Cuando el archivo esté en GitHub, basta con:

```text
Instala el MCP de WhatsApp siguiendo las instrucciones de este archivo, paso a paso y pidiéndome confirmación antes de instalar software del sistema: https://raw.githubusercontent.com/srsergi0/whatsapp-mcp/main/INSTALL_PROMPT.md
```

## Notas para quien mantiene el repo

- El flujo usa `git clone` + `npm install`, así que funciona sin publicar en npm.
- Si se publica en npm (`whatsapp-baileys-mcp`; el nombre `whatsapp-mcp` ya lo usa otro proyecto), el paso 4 y 5 se reducen a `claude mcp add whatsapp -- npx -y whatsapp-baileys-mcp`. En Windows nativo con Claude Code hay que anteponer `cmd /c`. Con `npx`, los datos van a `~/.whatsapp-mcp` (ver `defaultDataDir` en `src/config.ts`).
