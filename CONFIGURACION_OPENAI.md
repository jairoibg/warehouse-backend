# CONFIGURACIÓN DE OPENAI API KEY

## Instrucciones

El sistema ha sido migrado de Anthropic/Claude a OpenAI/ChatGPT.

### 1. Configurar la API Key

Añade la siguiente variable de entorno en tu archivo `.env`:

```env
OPENAI_API_KEY=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
```

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

