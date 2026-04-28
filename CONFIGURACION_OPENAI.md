# CONFIGURACIÓN DE OPENAI API KEY

## Instrucciones

El sistema ha sido migrado de Anthropic/Claude a OpenAI/ChatGPT.

### 1. Configurar la API Key

Añade la siguiente variable de entorno en tu archivo `.env`:

```env
OPENAI_API_KEY=<tu-api-key-de-openai>
```

> ⚠️ **IMPORTANTE (actualización auditoría 2026-04-24):** la API key real NO debe escribirse en este archivo ni versionarse en ningún commit. Configúrala únicamente en:
> - tu `.env` local (ignorado por git), o
> - las variables de entorno de Railway (panel → Variables).
>
> Si la clave anterior quedó expuesta en el historial git, **revócala en https://platform.openai.com/api-keys** y genera una nueva.

### 2. Verificar configuración

Después de añadir la variable de entorno, reinicia el servidor:

```bash
npm start
```

Deberías ver en los logs:
```
✅ Cliente OpenAI inicializado correctamente
```

### 3. Modelo utilizado

- **Modelo principal:** `gpt-4o` (GPT-4 Optimized)
- **Usado en:** Chatbot principal, análisis de packing lists, recomendaciones, optimización

### 4. Compatibilidad

El código mantiene compatibilidad hacia atrás:
- La función `getAnthropicClient()` sigue funcionando (retorna el cliente OpenAI)
- Variables de entorno antiguas (`ANTHROPIC_API_KEY`) se mantienen por compatibilidad pero no se usan

### 5. Fallback

Si la API key no está configurada, el sistema usará un modo fallback de búsqueda directa sin IA.

