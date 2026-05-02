/**
 * Rutas para IA y análisis inteligente
 */

import express from 'express';
import fs from 'fs/promises';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getOpenAIClient } from '../services/aiService.js';
import { getWarehouseContext, queryWarehouseData, queryDetailedData } from '../services/warehouseService.js';
import { analyzeSalesData } from '../services/analyticsService.js';
import { strategicAnalyzer } from '../../strategic_analyzer.js';
import { getConfig } from '../config/env.js';
import { LOCATIONS_FILE } from '../config/dataPaths.js';

const router = express.Router();

// Herramientas para ChatGPT
const chatGPTTools = [
  {
    name: "consultar_almacen",
    description: "Busca y filtra ubicaciones del almacén. Úsala para consultas como 'productos D de black con 20% de ocupación', 'ubicaciones vacías en pasillo 5', etc. Permite filtrar por ABC, marca, ocupación, temporada, antigüedad y más.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ALL", "EMPTY", "OCCUPIED"], description: "Estado: ALL=todas, EMPTY=vacías, OCCUPIED=ocupadas" },
        brand: { type: "string", enum: ["ALL", "BD", "GD", "WD"], description: "Marca: ALL=todas, BD=Black, GD=Gold, WD=White" },
        search_text: { type: "string", description: "Texto libre para buscar en códigos de producto, descripciones, etc." },
        min_days_old: { type: "number", description: "Antigüedad mínima en días (ej: 180 para productos antiguos)" },
        abc_class: { type: "string", enum: ["A", "B", "C", "D"], description: "Clase ABC: A (80% ventas), B (15%), C (5%), D (sin ventas)" },
        season: { type: "string", description: "Temporada (ej: 'V26'=Verano 2026, 'I23'=Invierno 2023)" },
        min_velocity: { type: "number", description: "Velocidad mínima de rotación" },
        check_mixing_a_d: { type: "boolean", description: "Buscar mezclas problemáticas de clase A con D" },
        hide_prices: { type: "boolean", description: "Ocultar precios en respuesta" },
        export_csv: { type: "boolean", description: "Exportar resultados a CSV" },
        auto_export_if_large: { type: "boolean", description: "Auto-exportar a CSV si hay más de 100 resultados" },
        min_occupancy_percent: { type: "number", description: "Ocupación mínima en porcentaje (0-100). Ej: 20 para '20% de ocupación'" },
        max_occupancy_percent: { type: "number", description: "Ocupación máxima en porcentaje (0-100). Ej: 30 para 'hasta 30%'" }
      },
      required: ["auto_export_if_large"]
    }
  },
  {
    name: "buscar_producto_referencia",
    description: "Busca un producto específico por su código o referencia. Úsala cuando el usuario mencione un código de producto específico (ej: 'dfksun0213', 'DFKSUN0213', 'IBGGGG202555'). También busca por packageId si es un código de paquete.",
    input_schema: {
      type: "object",
      properties: {
        codigo: { type: "string", description: "Código del producto o referencia a buscar (ej: 'dfksun0213', 'IBGGGG202555'). Puede ser código de producto o packageId." }
      },
      required: ["codigo"]
    }
  },
  {
    name: "analizar_ventas",
    description: "Consulta datos de ventas reales desde Odoo. Úsala para análisis de ventas históricas.",
    input_schema: {
      type: "object",
      properties: { 
        days_back: { type: "number", description: "Días hacia atrás para analizar (ej: 30, 90, 365)" },
        hide_prices: { type: "boolean", description: "Ocultar precios en respuesta" }
      },
      required: ["days_back"]
    }
  }
];

const DATA_DICTIONARY = `
### 📚 DICCIONARIO TÉCNICO (ODOO ERP + AUDITORÍA):
1. **STOCK FÍSICO:** Tabla \`stock.quant\`. Filtro \`usage='internal'\`.
2. **VALORACIÓN (€):** Σ (\`stock.quant.quantity\` * \`product.product.standard_price\`).
   - *Origen:* Coste estándar de la ficha del producto en Odoo.
3. **ABC:** Tabla \`abc.classification\` o calculado por IA (Ventas 365d) si falta en Odoo.
4. **ANTIGÜEDAD:** Días desde \`in_date\`.
`;

/**
 * POST /api/ai/report
 * Endpoint principal del agente IA
 */
router.post('/report', asyncHandler(async (req, res) => {
  const { query, history } = req.body;
  console.log(` 🤖  [AGENTE GPT] Procesando: "${query}"`);
  
  const dataPath = LOCATIONS_FILE;
  const raw = await fs.readFile(dataPath, 'utf8');
  const allLocations = JSON.parse(raw);

  const { audit, totalValue, itemsWithCost, totalItems } = await getWarehouseContext();

  const SYSTEM_PROMPT = `
Eres un asistente inteligente de almacén conectado en tiempo real a Odoo ERP. Tu trabajo es entender consultas en lenguaje natural y ejecutar las herramientas adecuadas.

### 🧠 COMPRENSIÓN DE LENGUAJE NATURAL:

**Ejemplos de consultas que debes entender:**

1. **"quiero ver todos los productos D de black con un 20% de ocupación"**
   → Usa \`consultar_almacen\` con: abc_class="D", brand="BD", min_occupancy_percent=15, max_occupancy_percent=25

2. **"quiero ver el paquete IBGGGG202555"** o **"muestra dfksun0213"**
   → Usa \`buscar_producto_referencia\` con codigo="IBGGGG202555" o codigo="dfksun0213"

3. **"productos clase A con más del 80% de ocupación"**
   → Usa \`consultar_almacen\` con: abc_class="A", min_occupancy_percent=80

4. **"ubicaciones vacías en pasillo 5"**
   → Usa \`consultar_almacen\` con: status="EMPTY", search_text="CLA-005" o "P05"

5. **"productos gold temporada V26"**
   → Usa \`consultar_almacen\` con: brand="GD", season="V26"

**REGLAS DE INTERPRETACIÓN:**
- "black" = BD, "gold" = GD, "white" = WD
- "productos D", "clase D", "categoría D" = abc_class="D"
- "20% de ocupación", "ocupación 20%", "20 por ciento" = min_occupancy_percent=15, max_occupancy_percent=25 (margen de ±5%)
- Cualquier código alfanumérico (ej: "dfksun0213", "IBGGGG202555") = buscar con \`buscar_producto_referencia\`
- "vacías", "vacíos", "huecos" = status="EMPTY"
- "ocupadas", "con stock" = status="OCCUPIED"

### 📊 ESTADO DEL ALMACÉN:
- Valor Total: €${totalValue.toLocaleString('es-ES')}
- Productos únicos: ${itemsWithCost.toLocaleString()}
- Ubicaciones totales: ${allLocations.length.toLocaleString()}

### ⛔ PROTOCOLO DE RESPUESTA:
1. **NUNCA listes IDs individuales** (CLA-001-01-01-01) a menos que el usuario lo pida explícitamente
2. **Agrupa y resume:** Si hay muchos resultados, agrupa por pasillo, marca, ABC, etc.
3. **Responde en español** de forma natural y concisa
4. **SIEMPRE ejecuta las herramientas** - no digas "no tengo acceso", siempre tienes acceso

### 🔧 HERRAMIENTAS DISPONIBLES:
- \`consultar_almacen\`: Para búsquedas y filtros complejos
- \`buscar_producto_referencia\`: Para buscar un producto/paquete específico por código
- \`analizar_ventas\`: Para análisis de ventas históricas

### 📝 DICCIONARIO TÉCNICO:
${DATA_DICTIONARY}
    `;


  let finalMapIds = [];
  let response;
  let finalText = "";
  let useFallback = false;
  
  // Verificar si hay API key antes de intentar usar OpenAI
  const config = getConfig();
  if (!config.openai.apiKey) {
    console.warn("⚠️ OPENAI_API_KEY no configurada, usando fallback directo");
    useFallback = true;
  }
  
  if (!useFallback) {
    try {
      const openai = getOpenAIClient();
      
      // Convertir herramientas al formato OpenAI
      const openaiTools = chatGPTTools.map(tool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema || {}
        }
      }));
      
      // Preparar mensajes con system prompt
      const openaiMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...(history || []).map(m => ({ 
          role: m.role === 'ai' ? 'assistant' : 'user', 
          content: m.content 
        })),
        { role: "user", content: query }
      ];
      
      let chatResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 4096,
        messages: openaiMessages,
        tools: openaiTools,
        tool_choice: "auto"
      });
      
      // Convertir respuesta de OpenAI a formato compatible
      let choice = chatResponse.choices[0];
      response = {
        stop_reason: choice.message.tool_calls && choice.message.tool_calls.length > 0 ? 'tool_use' : 'end_turn',
        content: choice.message.tool_calls ? choice.message.tool_calls.map(tc => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}')
        })) : [{ type: 'text', text: choice.message.content || '' }]
      };
      
      // Procesar tool_use si ChatGPT decide usar herramientas
      while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      const fnName = toolUse.name;
      const args = toolUse.input;
      let functionResult = "";

      console.log(` 🛠️  Ejecutando herramienta: ${fnName}`);

      if (fnName === 'consultar_almacen') {
        args.auto_export_if_large = true;
        const resultRaw = await queryWarehouseData(allLocations, args);
        functionResult = resultRaw;
        try {
          const parsed = JSON.parse(resultRaw);
          if (parsed.found_ids) finalMapIds = [...finalMapIds, ...parsed.found_ids];
        } catch (e) {}

      } else if (fnName === 'buscar_producto_referencia') {
        // Nueva herramienta para búsqueda de productos/paquetes
        const codigo = args.codigo || '';
        console.log(`🔍 [BUSCAR] Búsqueda de referencia: "${codigo}"`);
        try {
          const searchResult = await queryDetailedData({ 
            target: codigo, 
            type: 'PRODUCT' 
          });
          functionResult = searchResult;
          const parsed = JSON.parse(searchResult);
          if (Array.isArray(parsed)) {
            const ids = parsed.map(p => p.locationId).filter(Boolean);
            finalMapIds = [...finalMapIds, ...ids];
          }
        } catch(e) {
          console.error("Error en búsqueda de referencia:", e);
          functionResult = JSON.stringify({ found: false, error: e.message });
        }
      
      } else if (fnName === 'analizar_ventas') {
        functionResult = await analyzeSalesData(args);
      }

      toolResults.push({
        tool_use_id: toolUse.id,
        content: functionResult
      });
    }

    // Añadir respuesta del asistente con tool calls
    openaiMessages.push({ 
      role: "assistant", 
      content: choice.message.content || null,
      tool_calls: choice.message.tool_calls
    });
    
    // Añadir resultados de herramientas como mensajes de función
    toolResults.forEach(tr => {
      openaiMessages.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: tr.content
      });
    });

      // Nueva llamada con los resultados de herramientas
      chatResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 4096,
        messages: openaiMessages,
        tools: openaiTools,
        tool_choice: "auto"
      });
      
      choice = chatResponse.choices[0];
      response = {
        stop_reason: choice.message.tool_calls && choice.message.tool_calls.length > 0 ? 'tool_use' : 'end_turn',
        content: choice.message.tool_calls ? choice.message.tool_calls.map(tc => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}')
        })) : [{ type: 'text', text: choice.message.content || '' }]
      };
    }

      const textContent = response.content.find(block => block.type === 'text');
      finalText = textContent ? textContent.text : "No se pudo generar respuesta.";
      
    } catch (error) {
      console.error("❌ Error con OpenAI API:", error.message);
      useFallback = true;
    }
  }
  
  // FALLBACK: Solo si OpenAI falla completamente
  if (useFallback) {
    console.warn("⚠️ OpenAI API no disponible, usando fallback básico");
    finalText = `⚠️ **Servicio de IA no disponible temporalmente.**\n\n` +
      `Por favor, verifica que OPENAI_API_KEY esté configurada en el archivo .env y reinicia el servidor.\n\n` +
      `Ejemplo de configuración:\n` +
      `OPENAI_API_KEY=sk-proj-...\n\n` +
      `Sin la API key, el chatbot no puede procesar consultas en lenguaje natural.`;
  }

  res.json({ 
    text: finalText,
    map_highlight_ids: [...new Set(finalMapIds)],
    model: finalText.includes("FALLBACK") ? "Búsqueda Directa" : "GPT-4o"
  });
}));

/**
 * POST /api/strategic-analysis
 * Análisis estratégico completo
 */
router.post('/strategic-analysis', asyncHandler(async (req, res) => {
  console.log('🧠 [STRATEGY] Generando análisis estratégico completo...');
  
  const dataPath = LOCATIONS_FILE;
  const raw = await fs.readFile(dataPath, 'utf8');
  const locations = JSON.parse(raw);
  
  let salesData = null;
  try {
    const { getRealTimeSales } = await import('../services/odooService.js');
    salesData = await getRealTimeSales(30); 
  } catch (err) { 
    console.warn("No hay ventas disponibles para estrategia"); 
  }
  
  const intelligence = await strategicAnalyzer.gatherIntelligence(locations, salesData);
  const analysis = await strategicAnalyzer.generateStrategicReport(intelligence, req.body.history || []);
  
  res.json(analysis);
}));

/**
 * POST /api/strategic-chat
 * Chat estratégico conversacional
 */
router.post('/strategic-chat', asyncHandler(async (req, res) => {
  const { question, history } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'Pregunta requerida' });
  }

  console.log('🧠 [CHAT GPT] Pregunta:', question);

  const dataPath = LOCATIONS_FILE;
  const raw = await fs.readFile(dataPath, 'utf8');
  const locations = JSON.parse(raw);
  
  const intelligence = await strategicAnalyzer.gatherIntelligence(locations);

  const systemPrompt = `Eres un consultor estratégico de operaciones de almacén.
    CONTEXTO:
    - Ocupación: ${intelligence.basic.occupied}/${intelligence.basic.totalLocations}
    - Valor: €${intelligence.basic.totalValue.toFixed(0)}
    - Problemas críticos: ${intelligence.issues.filter(i => i.type === 'critical').length}
    Responde de forma CONCRETA y ESTRATÉGICA.`;

  const openaiMessages = [
    { role: "system", content: systemPrompt },
    ...(history || []).slice(-4).map(m => ({ 
      role: m.role === 'ai' ? 'assistant' : 'user', 
      content: m.content 
    })),
    { role: "user", content: question }
  ];

  const openai = getOpenAIClient();
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2048,
    messages: openaiMessages
  });

  const answer = response.choices[0].message.content;
  
  let highlightIds = [];
  if (question.toLowerCase().match(/(dónde|ubicaciones|mostrar|ver)/)) {
    if (question.toLowerCase().match(/(clase a| a )/)) {
      highlightIds = locations.filter(l => l.packages?.some(p => p.abcClass === 'A')).map(l => l.id).slice(0, 50);
    } else if (question.toLowerCase().match(/(zombie|antiguo)/)) {
      highlightIds = locations.filter(l => l.packages?.some(p => p.abcClass === 'D' && p.daysOld > 180)).map(l => l.id).slice(0, 50);
    }
  }

  res.json({ 
    answer, 
    map_highlight_ids: highlightIds, 
    intelligence: intelligence 
  });
}));

/**
 * GET /api/dashboard/metrics
 * Métricas para el Dashboard Visual
 */
router.get('/dashboard/metrics', asyncHandler(async (req, res) => {
  const { locations, totalValue } = await getWarehouseContext();
  
  const intelligence = await strategicAnalyzer.gatherIntelligence(locations);
  
  const kpis = {
    inventoryValue: { value: totalValue },
    occupancyRate: { value: parseFloat(intelligence.basic.occupancyRate) },
    criticalIssues: intelligence.issues.filter(i => i.type === 'critical').length,
    opportunities: intelligence.opportunities.length,
    abc: intelligence.abc.distribution,
    seasons: intelligence.seasons
  };

  res.json({ kpis, summary: { health: kpis.criticalIssues === 0 ? 'excellent' : 'fair' } });
}));

export default router;

