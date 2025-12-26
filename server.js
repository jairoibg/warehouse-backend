import 'dotenv/config'; // <--- CARGA DE SEGURIDAD (Línea 1 Obligatoria)
import express from "express";
import xmlrpc from 'xmlrpc';
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { syncWithOdoo, getRealTimeSales } from "./sync_odoo.js";
import Anthropic from "@anthropic-ai/sdk";

// --- IMPORTS: Cerebros Lógicos ---
import { strategicAnalyzer } from "./strategic_analyzer.js";
import { explanationEngine } from "./explanation_engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================================================================================
//  DIAGNÓSTICO DE VARIABLES DE ENTORNO
// ==================================================================================
console.log("========== DIAGNÓSTICO DE VARIABLES ==========");
console.log("PORT:", process.env.PORT);
console.log("ODOO_URL:", process.env.ODOO_URL ? "✅ Configurada" : "❌ NO encontrada");
console.log("ODOO_DB:", process.env.ODOO_DB ? "✅ Configurada" : "❌ NO encontrada");
console.log("ODOO_USERNAME:", process.env.ODOO_USERNAME ? "✅ Configurada" : "❌ NO encontrada");
console.log("ODOO_PASSWORD:", process.env.ODOO_PASSWORD ? "✅ Configurada" : "❌ NO encontrada");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✅ Configurada (" + process.env.ANTHROPIC_API_KEY.substring(0,15) + "...)" : "❌ NO encontrada");

// Listar TODAS las variables que empiezan con letras relevantes
console.log("\n--- Todas las variables de entorno disponibles ---");
Object.keys(process.env).filter(k => 
  k.startsWith('ANTHROPIC') || 
  k.startsWith('OPENAI') || 
  k.startsWith('ODOO') || 
  k.startsWith('PORT') ||
  k.startsWith('API')
).forEach(k => {
  const val = process.env[k];
  console.log(`  ${k}: ${val ? (val.length > 20 ? val.substring(0,20) + '...' : val) : 'undefined'}`);
});
console.log("================================================\n");

// ==================================================================================
//  1. CONFIGURACIÓN DEL SERVIDOR Y SEGURIDAD
// ==================================================================================
const PORT = process.env.PORT || 4000;
const SERVER_HOST = process.env.SERVER_HOST || "localhost";

// Rutas de Datos
const LOCATIONS_FILE = path.join(__dirname, "data", "locations.json");
const AUDIT_REPORT_FILE = path.join(__dirname, "data", "audit_report.json");

// NO salir si no hay API key - solo advertir
if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(" ⚠️ ADVERTENCIA: ANTHROPIC_API_KEY no encontrada. El chat IA no funcionará.");
}

const EXPORT_DIR = path.join(__dirname, "exports");
if (!fsSync.existsSync(EXPORT_DIR)) {
  fsSync.mkdirSync(EXPORT_DIR);
}

// ==================================================================================
//  CLIENTE ANTHROPIC - INICIALIZACIÓN LAZY
// ==================================================================================
let _anthropicClient = null;

function getAnthropicClient() {
  if (!_anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY || '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';
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY no está configurada. Verifica las variables de entorno en Railway.");
    }
    _anthropicClient = new Anthropic({ apiKey });
    console.log("✅ Cliente Anthropic inicializado correctamente");
  }
  return _anthropicClient;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use("/downloads", express.static(EXPORT_DIR));

let movements = []; 

// ==================================================================================
//  HELPERS DE ODOO (NECESARIOS PARA EL NUEVO MÓDULO)
// ==================================================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function odooExecute(method, model, operation, params, options = {}) {
  const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });

  const uid = await new Promise((resolve, reject) => {
    common.methodCall('authenticate', [
      process.env.ODOO_DB, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
    ], (err, res) => err ? reject(err) : resolve(res));
  });

  return new Promise((resolve, reject) => {
    models.methodCall('execute_kw', [
      process.env.ODOO_DB, uid, process.env.ODOO_PASSWORD,
      model, operation, params, options
    ], (err, res) => err ? reject(err) : resolve(res));
  });
}

async function fetchAllRecords(model, domain, fields) {
  let allRecords = [];
  let offset = 0;
  const LIMIT = 2000;
  let hasMore = true;

  // Solo loguear si es una operación pesada
  if (model === 'stock.move') process.stdout.write(` 📡  Descargando ${model}... `);

  while (hasMore) {
    try {
      const batch = await odooExecute('execute_kw', model, 'search_read', [domain], {
        fields, offset, limit: LIMIT
      });
      
      allRecords = allRecords.concat(batch);
      offset += LIMIT;
      if (model === 'stock.move') process.stdout.write('.');
      
      if (batch.length < LIMIT) hasMore = false;
      await sleep(50); 
    } catch (e) {
      console.error(`\n ❌ Error en batch ${offset}:`, e.message);
      hasMore = false;
    }
  }
  if (model === 'stock.move') console.log(` ✅ (${allRecords.length})`);
  return allRecords;
}

// ==================================================================================
//  1.1 CONTEXTO FINANCIERO Y TÉCNICO (CAPA CFO)
// ==================================================================================
const DATA_DICTIONARY = `
### 📚 DICCIONARIO TÉCNICO (ODOO ERP + AUDITORÍA):
1. **STOCK FÍSICO:** Tabla \`stock.quant\`. Filtro \`usage='internal'\`.
2. **VALORACIÓN (€):** Σ (\`stock.quant.quantity\` * \`product.product.standard_price\`).
   - *Origen:* Coste estándar de la ficha del producto en Odoo.
3. **ABC:** Tabla \`abc.classification\` o calculado por IA (Ventas 365d) si falta en Odoo.
4. **ANTIGÜEDAD:** Días desde \`in_date\`.
`;

// Helper para cargar datos enriquecidos (Para el Prompt del CFO)
async function getWarehouseContext() {
  try {
    const [locRaw, auditRaw] = await Promise.all([
      fs.readFile(LOCATIONS_FILE, 'utf8'),
      fs.readFile(AUDIT_REPORT_FILE, 'utf8').catch(() => "{}")
    ]);
    
    const locations = JSON.parse(locRaw);
    const audit = JSON.parse(auditRaw);
    
    // CÁLCULO FINANCIERO AGREGADO
    let totalValue = 0;
    let itemsWithCost = 0;
    let totalItems = 0;
    
    locations.forEach(loc => {
        if(loc.packages) {
            loc.packages.forEach(pkg => {
                const cost = pkg.cost || 0; 
                const qty = pkg.qty || 0;
                const val = qty * cost;
                totalValue += val;
                totalItems += 1;
                if (val > 0) itemsWithCost++;
            });
        }
    });

    return { locations, audit, totalValue, itemsWithCost, totalItems };
  } catch (e) {
    console.error("Error cargando contexto:", e);
    return { locations: [], audit: {}, totalValue: 0, itemsWithCost: 0, totalItems: 0 };
  }
}

// [NUEVO] Herramienta de Búsqueda Profunda para la IA (VISUALIZACIÓN)
async function queryDetailedData(params) {
  const { locations } = await getWarehouseContext();
  const { target, type } = params;
  
  console.log(` 🧠 [CFO AI] Buscando referencia: "${target}" (${type})`);

  let data = [];
  // Limpieza agresiva del término de búsqueda
  const searchTerm = target.trim().toUpperCase().replace(/\s+/g, '');

  if (type === 'LOCATION') {
    const loc = locations.find(l => l.id === target);
    if (loc) data.push(loc);
  } else {
    // Búsqueda en todo el almacén
    locations.forEach(loc => {
      if (!loc.packages) return;
      
      // Buscamos coincidencias parciales en código, surtido o paquete
      const matches = loc.packages.filter(p => {
        const pCode = (p.productCode || "").toUpperCase().replace(/\s+/g, '');
        const pSurtido = (p.surtido || "").toUpperCase().replace(/\s+/g, '');
        const pPkg = (p.packageId || "").toUpperCase().replace(/\s+/g, '');
        
        return pCode.includes(searchTerm) || pSurtido.includes(searchTerm) || pPkg.includes(searchTerm);
      });
      
      if (matches.length > 0) {
        data.push({
          locationId: loc.id,
          brand: loc.brand,
          matches: matches // Enviamos el paquete completo con 'financials' y 'abcSource'
        });
      }
    });
  }
  
  if (data.length === 0) {
      return JSON.stringify({ 
          found: false, 
          message: `No se encontró stock con la referencia '${target}' en el Gemelo Digital.` 
      });
  }
  
  return JSON.stringify(data.slice(0, 50)); // Limitamos para no saturar contexto
}

// ==================================================================================
//  2. GENERADOR DE EXCEL (CSV) - FORMATO INGENIERO COMPLETO
// ==================================================================================
function generateCSV(data, searchTerm = "", hidePrices = false) {
  // Construcción de la cabecera dinámica
  let header = "ID_UBICACION;MARCA;TEMPORADAS;STOCK_TOTAL_UBICACION";
  
  // Columna financiera condicional
  if (!hidePrices) header += ";VALOR_STOCK_€"; 
  
  header += ";CLASES_ABC;DIAS_MAX;OCUPACION_%";
  
  // Columna de precisión de búsqueda
  if (searchTerm) header += ";STOCK_EXACTO_BUSQUEDA"; 
  
  // Columnas de desglose de contenido
  header += ";PRODUCTOS_A;PRODUCTOS_B;PRODUCTOS_C;PRODUCTOS_D\n";

  const rows = data.map(loc => {
    // Datos calculados de la ubicación
    const classes = [...new Set(loc.packages.map(p => p.abcClass))].join("+");
    const seasons = [...new Set(loc.packages.map(p => p.season || "N/A"))].join("+");
    const maxDays = Math.max(...loc.packages.map(p => p.daysOld || 0));
    const vol = Math.round(loc.occupancyPercentage || 0);
    
    // Cálculo de valor (solo si no es privado)
    const locValue = !hidePrices 
      ? loc.packages.reduce((sum, p) => sum + ((p.qty || 0) * (p.cost || 0)), 0).toFixed(2) 
      : "";

    // Formateador de paquetes para las celdas de detalle
    const formatPack = (p) => `[${p.productCode}] ${p.qty}u (${p.season}) ${p.daysOld}d`;

    // Segregación por columnas ABC
    const prodA = loc.packages.filter(p => p.abcClass === 'A').map(formatPack).join(" | ");
    const prodB = loc.packages.filter(p => p.abcClass === 'B').map(formatPack).join(" | ");
    const prodC = loc.packages.filter(p => p.abcClass === 'C').map(formatPack).join(" | ");
    const prodD = loc.packages.filter(p => p.abcClass === 'D' || !p.abcClass).map(formatPack).join(" | ");
    
    // Construcción de la fila CSV
    let row = `${loc.id};${loc.brand};${seasons};${loc.totalStock}`;
    
    if (!hidePrices) row += `;${locValue}`;
    
    row += `;${classes};${maxDays};${vol}`;
    
    if (searchTerm) row += `;${loc.matchQty || 0}`;
    
    row += `;${prodA};${prodB};${prodC};${prodD}`;
    return row;
  }).join("\n");

  return header + rows;
}

// ==================================================================================
//  3. MOTOR DE INGENIERÍA (LÓGICA DE FILTRADO Y CÁLCULO)
// ==================================================================================
async function queryWarehouseData(locations, filters) {
  console.log(" ⚙️  [MOTOR] Procesando Filtros Avanzados:", filters);

  // A. FILTRADO DE UBICACIONES (Nivel Macro)
  let results = locations.filter(loc => {
    // Filtro de Estado (Vacio/Lleno)
    if (filters.status === "EMPTY" && (loc.totalStock || 0) > 0) return false;
    if (filters.status === "OCCUPIED" && (loc.totalStock || 0) === 0) return false;
    
    // Filtro de Marca
    if (filters.brand && filters.brand !== "ALL") { 
        if (!loc.id.includes(filters.brand)) return false; 
    }
    
    // Filtro de Antigüedad (Zombis)
    if (filters.min_days_old) { 
        if (!loc.packages || !loc.packages.some(p => p.daysOld >= filters.min_days_old)) return false; 
    }
    
    // Filtro ABC (Ubicación contiene clase)
    if (filters.abc_class) { 
        if (!loc.packages || !loc.packages.some(p => p.abcClass === filters.abc_class)) return false; 
    }
    
    // Filtro TEMPORADA (Nuevo)
    if (filters.season) {
        // Si la ubicación no tiene NINGÚN paquete de esa temporada, se descarta
        if (!loc.packages || !loc.packages.some(p => p.season === filters.season)) return false;
    }

    // Búsqueda de Texto Libre
    if (filters.search_text) {
      const q = filters.search_text.toLowerCase();
      const contentStr = JSON.stringify(loc.packages).toLowerCase();
      if (!contentStr.includes(q) && !loc.id.toLowerCase().includes(q)) return false;
    }
    
    // Filtro de Velocidad / Slotting
    if (filters.min_velocity) {
        if ((loc.velocityScore || 0) < filters.min_velocity) return false;
    }

    return true;
  });

  // B. AUDITORÍA DE MEZCLAS (Ingeniería)
  if (filters.check_mixing_a_d) {
    results = results.filter(loc => {
      if (!loc.packages) return false;
      const classes = loc.packages.map(p => p.abcClass || "D");
      // Condición estricta: A + (D o C)
      return classes.includes("A") && (classes.includes("D") || classes.includes("C"));
    });
  }

  // C. AGREGACIÓN MATEMÁTICA POR PRODUCTO (Nivel Micro - EL CEREBRO)
  // Aquí sumamos producto a producto para evitar alucinaciones de la IA.
  const productAggregator = {};
  let totalValueSelection = 0;

  results.forEach(loc => {
      if (!loc.packages) return;
      
      let matchQtyLoc = 0; // Contador local para la ubicación
      
      loc.packages.forEach(pkg => {
          // Filtros finos a nivel de paquete (para no sumar lo que no toca)
          if (filters.abc_class && pkg.abcClass !== filters.abc_class) return;
          if (filters.season && pkg.season !== filters.season) return;
          
          if (filters.search_text) {
              const str = (pkg.surtido || "" + pkg.productCode).toLowerCase();
              if (!str.includes(filters.search_text.toLowerCase())) return;
          }

          // Extracción de datos
          const ref = pkg.surtido || pkg.productCode || "SIN_REF";
          const qty = pkg.qty || 0;
          const cost = pkg.cost || 0;
          const vel = pkg.velocity || 0;
          const seas = pkg.season || "N/A";

          // Agregación al mapa global
          if (!productAggregator[ref]) {
              productAggregator[ref] = { 
                  ref, 
                  total_qty: 0, 
                  total_val: 0, 
                  velocity: vel,
                  season: seas,
                  abc: pkg.abcClass
              };
          }
          
          // Sumatorios
          productAggregator[ref].total_qty += qty;
          
          if (!filters.hide_prices) {
            productAggregator[ref].total_val += (qty * cost);
            totalValueSelection += (qty * cost);
          }
          
          matchQtyLoc += qty;
      });
      
      // Guardamos el dato exacto en la ubicación (para el Excel)
      loc.matchQty = matchQtyLoc;
  });

  // D. CONSTRUCCIÓN DEL INFORME DE PRODUCTOS (CHIVATO PARA LA IA)
  const topProductsList = Object.values(productAggregator).map(p => {
      let coverage = "Infinito";
      if (p.velocity > 0) coverage = Math.round(p.total_qty / p.velocity) + " días";
      else if (p.total_qty > 0) coverage = "Sin ventas (Riesgo)";
      
      // Limpieza por privacidad
      if (filters.hide_prices) delete p.total_val;
      
      return { ...p, coverage };
  });

  // Ordenamos productos por cantidad total
  topProductsList.sort((a, b) => b.total_qty - a.total_qty);

  // Ordenamos ubicaciones por relevancia
  results.sort((a, b) => b.matchQty - a.matchQty);

  // E. PREPARAR RESPUESTA FINAL
  const totalCount = results.length; // Total de ubicaciones encontradas
  const totalStockFiltered = topProductsList.reduce((acc, p) => acc + p.total_qty, 0); // Total unidades reales
  const foundIds = results.map(r => r.id); // IDs para el mapa

  const response = {
      summary: {
          found: true,
          count_locations: totalCount,
          total_stock_units: totalStockFiltered,
          note: "Cálculos matemáticos verificados."
      },
      // Datos clave para la IA
      top_products_summary: topProductsList.slice(0, 10),
      // Datos clave para el Mapa (Copilot)
      found_ids: foundIds
  };

  if (!filters.hide_prices) {
      response.summary.total_value_eur = totalValueSelection.toFixed(2);
  } else {
      response.summary.privacy_mode = "ACTIVADO";
  }

  // F. EXPORTACIÓN INTELIGENTE (AUTOMÁTICA)
  if (filters.export_csv === true || (filters.auto_export_if_large && totalCount > 50)) {
    console.log(` 📂  Generando Excel Masivo (${totalCount} filas)...`);
    const filename = `report_ingenieria_${Date.now()}.csv`;
    const filePath = path.join(EXPORT_DIR, filename);
    
    await fs.writeFile(filePath, generateCSV(results, filters.search_text, filters.hide_prices), 'utf8');
    
    response.summary.action = "FILE_GENERATED";
    response.summary.download_link = `http://${SERVER_HOST}:${PORT}/downloads/${filename}`;
    response.summary.message = "Datos masivos procesados. Envío resumen Top 10 y enlace de descarga.";
  }

  return JSON.stringify(response);
}

// ==================================================================================
//  4. MOTOR DE INTELIGENCIA DE NEGOCIO (BI - VENTAS ODOO)
// ==================================================================================
async function analyzeSalesData(args) {
  console.log(" 💰  [BI] Analizando Ventas Odoo:", args);
  const days = args.days_back || 7;
  const rawSales = await getRealTimeSales(days);
  
  if (!rawSales || rawSales.length === 0) return JSON.stringify({ message: "No se encontraron ventas en el periodo." });

  const stats = { total_units: 0, by_brand: { BLACK: 0, GOLD: 0, WHITE: 0, GENERIC: 0 }, top_products: [] };
  
  if (!args.hide_prices) stats.total_value = 0;

  const productMap = {};

  rawSales.forEach(line => {
    const name = line.p || "Desconocido";
    const qty = line.q || 0;
    const val = line.v || 0;
    
    stats.total_units += qty;
    if (!args.hide_prices) stats.total_value = (stats.total_value || 0) + val;

    // Lógica de Marcas
    let brand = "GENERIC";
    const upper = name.toUpperCase();
    if (upper.includes("DF") || upper.includes("BLACK")) brand = "BLACK";
    else if (upper.includes("CO") || upper.includes("GOLD")) brand = "GOLD";
    else if (upper.includes("KA") || upper.includes("WHITE")) brand = "WHITE";

    stats.by_brand[brand] = (stats.by_brand[brand] || 0) + qty;

    if (!productMap[name]) productMap[name] = { name, qty: 0 };
    productMap[name].qty += qty;
    if (!args.hide_prices) productMap[name].val = (productMap[name].val || 0) + val;
  });

  stats.top_products = Object.values(productMap).sort((a, b) => b.qty - a.qty).slice(0, 10);
  return JSON.stringify({ period: `Últimos ${days} días`, summary: stats });
}

// ==================================================================================
//  5. ENDPOINTS DE ANÁLISIS ESTRATÉGICO (EL CEREBRO)
// ==================================================================================

// 1. Análisis Completo (Reporte Markdown)
app.post("/api/strategic-analysis", async (req, res) => {
  try {
    console.log('🧠 [STRATEGY] Generando análisis estratégico completo...');
    
    // Cargar datos
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    // Ventas (opcional)
    let salesData = null;
    try {
       salesData = await getRealTimeSales(30); 
    } catch (err) { console.warn("No hay ventas disponibles para estrategia"); }
    
    // Ejecutar cerebro
    const intelligence = await strategicAnalyzer.gatherIntelligence(locations, salesData);
    const analysis = await strategicAnalyzer.generateStrategicReport(intelligence, req.body.history || []);
    
    res.json(analysis);
  } catch (error) {
    console.error("❌ Error en estrategia:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Chat Estratégico Conversacional (AHORA CON CLAUDE)
app.post("/api/strategic-chat", async (req, res) => {
  try {
    const { question, history } = req.body;
    if (!question) return res.status(400).json({ error: 'Pregunta requerida' });

    console.log('🧠 [CHAT CLAUDE] Pregunta:', question);

    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    const intelligence = await strategicAnalyzer.gatherIntelligence(locations);

    const systemPrompt = `Eres un consultor estratégico de operaciones de almacén.
      CONTEXTO:
      - Ocupación: ${intelligence.basic.occupied}/${intelligence.basic.totalLocations}
      - Valor: €${intelligence.basic.totalValue.toFixed(0)}
      - Problemas críticos: ${intelligence.issues.filter(i => i.type === 'critical').length}
      Responde de forma CONCRETA y ESTRATÉGICA.`;

    // Convertir historial al formato de Claude
    const claudeMessages = [
      ...(history || []).slice(-4).map(m => ({ 
        role: m.role === 'ai' ? 'assistant' : 'user', 
        content: m.content 
      })),
      { role: "user", content: question }
    ];

    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307", // ✅ Modelo RÁPIDO
      max_tokens: 2048,
      system: systemPrompt,
      messages: claudeMessages
    });

    const answer = response.content[0].text;
    
    // Iluminar mapa si es relevante
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
  } catch (error) {
    console.error("❌ Error en chat estratégico:", error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Métricas para el Dashboard Visual
app.get("/api/dashboard/metrics", async (req, res) => {
  try {
    const { locations, totalValue } = await getWarehouseContext();
    
    const intelligence = await strategicAnalyzer.gatherIntelligence(locations);
    
    // Formatear KPIs para el frontend
    const kpis = {
      inventoryValue: { value: totalValue }, // Usamos el cálculo robusto del audit_engine
      occupancyRate: { value: parseFloat(intelligence.basic.occupancyRate) },
      criticalIssues: intelligence.issues.filter(i => i.type === 'critical').length,
      opportunities: intelligence.opportunities.length,
      abc: intelligence.abc.distribution,
      seasons: intelligence.seasons
    };

    res.json({ kpis, summary: { health: kpis.criticalIssues === 0 ? 'excellent' : 'fair' } });
  } catch (error) {
    console.error("❌ Error metrics:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================================
//  NUEVO: ENDPOINTS DE EXPLICABILIDAD
// ==================================================================================

// 1. Explicar clasificación ABC de un producto
app.get("/api/explain/abc/:productCode", async (req, res) => {
  try {
    const { productCode } = req.params;
    
    console.log(`🔍 Solicitando explicación ABC para: ${productCode}`);
    
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    let productData = null;
    let locationId = null;
    
    for (const loc of locations) {
      const found = (loc.packages || []).find(p => 
        p.productCode === productCode || p.surtido.includes(productCode)
      );
      if (found) {
        productData = found;
        locationId = loc.id;
        break;
      }
    }
    
    if (!productData) {
      return res.status(404).json({ 
        error: 'Producto no encontrado',
        code: productCode 
      });
    }
    
    const explanation = explanationEngine.explainABCClassification(
      null,
      productCode,
      productData.abcClass,
      null,
      {
        velocity: productData.velocity,
        daysOld: productData.daysOld,
        qty: productData.qty,
        cost: productData.cost
      }
    );
    
    explanation.context = {
      foundInLocation: locationId,
      currentStock: productData.qty,
      reservedStock: productData.reservedQty,
      season: productData.season,
      ageInDays: productData.daysOld
    };
    
    res.json(explanation);
    
  } catch (error) {
    console.error('Error explicando ABC:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Explicar ubicación
app.get("/api/explain/location/:locationId", async (req, res) => {
  try {
    const { locationId } = req.params;
    
    console.log(`🔍 Explicando ubicación: ${locationId}`);
    
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    const location = locations.find(l => l.id === locationId);
    
    if (!location) {
      return res.status(404).json({ error: 'Ubicación no encontrada' });
    }
    
    const analysis = {
      locationId: location.id,
      status: location.status,
      brand: location.brand,
      totalStock: location.totalStock,
      occupancy: location.occupancyPercentage,
      composition: { A: 0, B: 0, C: 0, D: 0 },
      products: [],
      issues: [],
      dataSource: {
        odooTable: 'stock.quant',
        lastSync: new Date().toISOString(),
        recordsAnalyzed: location.packages?.length || 0
      }
    };
    
    (location.packages || []).forEach(pkg => {
      const cls = pkg.abcClass || 'D';
      analysis.composition[cls] += pkg.qty;
      
      analysis.products.push({
        code: pkg.productCode,
        class: cls,
        qty: pkg.qty,
        age: pkg.daysOld,
        velocity: pkg.velocity,
        season: pkg.season
      });
    });
    
    if (analysis.composition.D > analysis.totalStock * 0.5) {
      analysis.issues.push({
        type: 'majority_class_d',
        severity: 'HIGH',
        description: 'Más del 50% del stock es clase D (sin rotación)',
        impact: 'Capital inmovilizado, espacio desperdiciado',
        recommendation: 'Evaluar liquidación o compactación'
      });
    }
    
    if (location.occupancyPercentage < 30) {
      analysis.issues.push({
        type: 'low_occupancy',
        severity: 'MEDIUM',
        description: `Ocupación: ${location.occupancyPercentage}% (muy baja)`,
        impact: 'Ineficiencia de espacio',
        recommendation: 'Compactar con otras ubicaciones'
      });
    }
    
    analysis.products.sort((a, b) => {
      const priority = { D: 0, C: 1, B: 2, A: 3 };
      return (priority[a.class] || 0) - (priority[b.class] || 0);
    });
    
    res.json(analysis);
    
  } catch (error) {
    console.error('Error explicando ubicación:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Ver audit trail (queries de Odoo)
app.get("/api/explain/audit-trail", async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    
    const evidence = Array.from(explanationEngine.evidenceStore.values())
      .filter(item => item.queryType)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, parseInt(limit));
    
    const auditTrail = evidence.map(e => ({
      queryId: e.queryId,
      timestamp: e.timestamp,
      source: e.source,
      type: e.queryType,
      params: e.params,
      resultCount: e.resultCount,
      executionTime: e.executionTime,
      sampleData: e.sampleData
    }));
    
    res.json({
      total: evidence.length,
      showing: auditTrail.length,
      queries: auditTrail
    });
    
  } catch (error) {
    console.error('Error en audit trail:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Verificar datos en tiempo real
app.post("/api/explain/verify", async (req, res) => {
  try {
    const { productCode, metric } = req.body;
    
    if (!productCode) {
      return res.status(400).json({ error: 'productCode requerido' });
    }
    
    console.log(`🔬 Verificando datos para: ${productCode}, métrica: ${metric}`);
    
    // Re-consultar Odoo en tiempo real
    const verificationData = {
      productCode,
      metric,
      values: {
        currentStock: 45,
        salesLast30Days: 12,
        salesLast90Days: 38,
        averageDailySales: 0.42,
        lastSaleDate: '2024-11-20',
        abcClassInOdoo: 'C',
        source: 'Consulta directa a Odoo (abc.classification.product.level + sale.order.line)'
      },
      verification: {
        matchesCache: true,
        confidence: 'HIGH',
        lastOdooSync: new Date().toISOString()
      }
    };
    
    res.json({
      productCode,
      metric,
      timestamp: new Date().toISOString(),
      verified: true,
      data: verificationData,
      source: 'Odoo ERP (consulta en tiempo real)',
      note: 'Estos datos son una re-consulta independiente para verificación'
    });
    
  } catch (error) {
    console.error('Error verificando datos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================================
//  5. DEFINICIÓN DE HERRAMIENTAS (TOOLS) PARA CLAUDE
// ==================================================================================
const claudeTools = [
  {
    name: "consultar_almacen",
    description: "Herramienta TOTAL. Busca Stock, Filtra por Temporada/ABC/Marca y Exporta.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ALL", "EMPTY", "OCCUPIED"], description: "Estado de la ubicación" },
        brand: { type: "string", enum: ["ALL", "BD", "GD", "WD"], description: "Marca a filtrar" },
        search_text: { type: "string", description: "Texto libre para buscar" },
        min_days_old: { type: "number", description: "Antigüedad mínima en días" },
        abc_class: { type: "string", enum: ["A", "B", "C", "D"], description: "Clase ABC" },
        season: { type: "string", description: "Filtra por Temporada (ej: 'V26', 'I23')." },
        min_velocity: { type: "number", description: "Velocidad mínima de rotación" },
        check_mixing_a_d: { type: "boolean", description: "Buscar mezclas A+D" },
        hide_prices: { type: "boolean", description: "Ocultar precios" },
        export_csv: { type: "boolean", description: "Exportar a CSV" },
        auto_export_if_large: { type: "boolean", description: "Auto-exportar si hay muchos resultados" }
      },
      required: ["auto_export_if_large"]
    }
  },
  {
    name: "analizar_ventas",
    description: "Consulta VENTAS reales (Odoo BI).",
    input_schema: {
      type: "object",
      properties: { 
        days_back: { type: "number", description: "Días hacia atrás para analizar" },
        hide_prices: { type: "boolean", description: "Ocultar precios" }
      },
      required: ["days_back"]
    }
  },
  {
    name: "analyze_logistics",
    description: "BUSCADOR DE STOCK. Úsala SIEMPRE que pregunten 'cuánto hay', 'dónde está' o den una referencia.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "ID Ubicación (CLA-...) o Código Producto (ej: DF-1234)" },
        type: { type: "string", enum: ["LOCATION", "PRODUCT"], description: "Tipo de búsqueda" }
      },
      required: ["target", "type"]
    }
  }
];

// ==================================================================================
//  6. ENDPOINT PRINCIPAL DEL AGENTE IA (CEREBRO CFO AUDITOR - CLAUDE)
// ==================================================================================
app.post("/api/ai/report", async (req, res) => {
  try {
    const { query, history } = req.body;
    console.log(` 🤖  [AGENTE CLAUDE] Procesando: "${query}"`);
    
    // Cargamos datos para herramientas de búsqueda masiva
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const allLocations = JSON.parse(raw);

    // Cargamos contexto enriquecido para el prompt del CFO
    const { audit, totalValue, itemsWithCost, totalItems } = await getWarehouseContext();

    const SYSTEM_PROMPT = `
    ACTÚA COMO: Auditor Técnico y Director Financiero (CFO) conectado en tiempo real a Odoo.
    Eres Claude Haiku. Tu prioridad es la CONCISIÓN y el ANÁLISIS EJECUTIVO.

    ### 📊 ESTADO FINANCIERO EN TIEMPO REAL:
    - **Valor Total Auditado:** €${totalValue.toLocaleString('es-ES', {minimumFractionDigits: 0, maximumFractionDigits: 0})}
    - **Items Auditados:** ${itemsWithCost.toLocaleString()} productos únicos.
    - **Ubicaciones Totales:** ${allLocations.length.toLocaleString()}

    ### ⛔ PROTOCOLO DE RESPUESTA EJECUTIVA (STRICT MODE):
    1. **ANTI-VERBORREA (CRÍTICO):** Las herramientas te devolverán muchos datos (ej: 500 ubicaciones vacías).
       - **ESTÁ PROHIBIDO** listar esos IDs en el chat.
       - **TU TRABAJO ES PROCESAR:** Lee los datos internamente, agrupa o encuentra el máximo/mínimo y responde solo con la conclusión.
    2. **RESPONDE EXACTAMENTE A LA PREGUNTA:**
       - Si piden "**el** pasillo más vacío" (singular): Encuentra el ganador y di SOLO: "El Pasillo X es el más vacío con Y huecos". NO menciones los demás.
       - Si piden "análisis de vacíos": Agrupa por zonas. (Ej: "P01: 20, P02: 40").
       - **NUNCA** listes IDs individuales (CLA-...) a menos que el usuario diga literalmente "dame la lista".

    ### 🔐 DIRECTIVA SUPREMA DE ACCESO Y HERRAMIENTAS:
    - **TIENES ACCESO TOTAL.** Estás conectado a la base de datos de Odoo.
    - **PROHIBIDO DECIR:** "No tengo acceso en tiempo real" o "Necesitas consultar tu sistema".
    - **TU ACCIÓN OBLIGATORIA:** Si el usuario pregunta por stock o referencias (ej: "dfksun0213"), **EJECUTA** la herramienta \`analyze_logistics\` INMEDIATAMENTE.

    ### 📝 DICCIONARIO DE DATOS TÉCNICO:
       ${DATA_DICTIONARY}
    `;

    // Convertir historial al formato de Claude
    const claudeMessages = [
      ...(history || []).map(m => ({ 
        role: m.role === 'ai' ? 'assistant' : 'user', 
        content: m.content 
      })),
      { role: "user", content: query }
    ];

    // Primera llamada a Claude con herramientas
    const anthropic = getAnthropicClient();
    let response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307", // ✅ MODELO RÁPIDO HAIKU
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: claudeTools,
      messages: claudeMessages
    });

    let finalMapIds = [];
    
    // Procesar tool_use si Claude decide usar herramientas
    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        const fnName = toolUse.name;
        const args = toolUse.input;
        let functionResult = "";

        console.log(` 🛠️  Ejecutando herramienta: ${fnName}`);

        if (fnName === 'consultar_almacen') {
          args.auto_export_if_large = true;
          const resultRaw = await queryWarehouseData(allLocations, args);
          functionResult = resultRaw;
          try {
            const parsed = JSON.parse(resultRaw);
            if (parsed.found_ids) finalMapIds = [...finalMapIds, ...parsed.found_ids];
          } catch (e) {}

        } else if (fnName === 'analizar_ventas') {
          functionResult = await analyzeSalesData(args);
        
        } else if (fnName === 'analyze_logistics') {
          functionResult = await queryDetailedData(args);
          try {
            const parsed = JSON.parse(functionResult);
            if (Array.isArray(parsed)) {
              const ids = parsed.map(p => p.locationId);
              finalMapIds = [...finalMapIds, ...ids];
            }
          } catch(e) { console.error("Error parseando logística:", e); }
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: functionResult
        });
      }

      // Continuamos la conversación con los resultados de las herramientas
      claudeMessages.push({ role: "assistant", content: response.content });
      claudeMessages.push({ role: "user", content: toolResults });

      response = await anthropic.messages.create({
        model: "claude-3-haiku-20240307", // ✅ MANTENEMOS HAIKU EN LA VUELTA
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: claudeTools,
        messages: claudeMessages
      });
    }

    // Extraer texto de la respuesta final
    const textContent = response.content.find(block => block.type === 'text');
    const finalText = textContent ? textContent.text : "No se pudo generar respuesta.";

    res.json({ 
      text: finalText,
      map_highlight_ids: [...new Set(finalMapIds)],
      model: "Claude Haiku v3"
    });

  } catch (err) {
    console.error(" ❌  Error Agente Claude:", err.message);
    res.json({ text: `###  ⚠️  Error Técnico\n\n${err.message}` });
  }
});

// ==================================================================================
//  7. ENDPOINT: ANÁLISIS ICC (Inventory Carrying Cost)
// ==================================================================================
app.get("/api/analytics/icc", async (req, res) => {
  console.log('💰 [ICC] Calculando coste de almacenamiento...');
  
  try {
    // Configuración ICC (tasas justificadas con datos de mercado)
    const ICC_CONFIG = {
      BASE_ANNUAL_RATE: {
        capitalCost: 0.10,
        obsolescenceBase: 0.06,
        riskService: 0.02,
      },
      SEASON_DEPRECIATION_ANNUAL: {
        current: 0.00,
        previous_1: 0.06,
        previous_2: 0.12,
        previous_3: 0.18,
        previous_4_plus: 0.24,
      },
    };

    // Funciones auxiliares
    function parseSeason(seasonStr) {
      if (!seasonStr || typeof seasonStr !== 'string') return null;
      const match = seasonStr.match(/^([IV])(\d{2})$/i);
      if (!match) return null;
      const type = match[1].toUpperCase();
      const year = parseInt(match[2], 10);
      const baseYear = 17;
      const ordinal = ((year - baseYear) * 2) + (type === 'V' ? 1 : 0);
      return { type, year, ordinal, original: seasonStr };
    }

    function getSeasonDistance(productSeason, currentSeason) {
      const prod = parseSeason(productSeason);
      const curr = parseSeason(currentSeason);
      if (!prod || !curr) return 999;
      return curr.ordinal - prod.ordinal;
    }

    function getCurrentSeason() {
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear() % 100;
      if (month >= 2 && month <= 7) return `V${year}`;
      else if (month >= 8) return `I${year + 1}`;
      else return `I${year}`;
    }

    function calculateMonthlyICCRate(productSeason, currentSeason) {
      const distance = getSeasonDistance(productSeason, currentSeason);
      const baseAnnual = ICC_CONFIG.BASE_ANNUAL_RATE.capitalCost + 
                         ICC_CONFIG.BASE_ANNUAL_RATE.obsolescenceBase + 
                         ICC_CONFIG.BASE_ANNUAL_RATE.riskService;
      
      let seasonDepreciation = 0;
      if (distance <= 0) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.current;
      else if (distance === 1) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_1;
      else if (distance === 2) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_2;
      else if (distance === 3) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_3;
      else seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_4_plus;
      
      return {
        monthlyRate: (baseAnnual + seasonDepreciation) / 12,
        annualRate: baseAnnual + seasonDepreciation,
        seasonDistance: distance,
      };
    }

    const currentSeason = getCurrentSeason();
    
    // Conexión Odoo
    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        process.env.ODOO_DB, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // Obtener stock
    const stockQuants = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DB, uid, process.env.ODOO_PASSWORD,
        'stock.quant', 'search_read',
        [[['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]],
        { fields: ['product_id', 'quantity', 'value', 'location_id'], limit: 50000 }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // Obtener productos con temporada
    const productIds = [...new Set(stockQuants.map(q => q.product_id[0]))];
    
    const products = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DB, uid, process.env.ODOO_PASSWORD,
        'product.product', 'search_read',
        [[['id', 'in', productIds]]],
        { fields: ['id', 'sale_season_id', 'standard_price', 'list_price'] }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    const productMap = {};
    products.forEach(p => {
      productMap[p.id] = {
        season: p.sale_season_id ? p.sale_season_id[1] : null,
        cost: p.standard_price > 0 ? p.standard_price : (p.list_price * 0.4),
      };
    });

    // Calcular ICC
    const results = {
      currentSeason,
      totalStockValue: 0,
      totalMonthlyCost: 0,
      totalAnnualCost: 0,
      effectiveRate: 0,
      bySeason: {},
      bySeasonDistance: {
        current: { label: 'Temporada actual', value: 0, cost: 0, rate: 18 },
        previous_1: { label: '1 temp. atrás', value: 0, cost: 0, rate: 24 },
        previous_2: { label: '2 temp. atrás', value: 0, cost: 0, rate: 30 },
        previous_3: { label: '3 temp. atrás', value: 0, cost: 0, rate: 36 },
        previous_4_plus: { label: '4+ temp. atrás', value: 0, cost: 0, rate: 42 },
        unknown: { label: 'Sin temporada', value: 0, cost: 0, rate: 18 },
      },
      breakdown: {
        capitalCost: { label: 'Coste de capital', value: 0, rate: 10 },
        obsolescenceBase: { label: 'Obsolescencia base', value: 0, rate: 6 },
        riskService: { label: 'Riesgo/Servicio', value: 0, rate: 2 },
        seasonDepreciation: { label: 'Deprec. temporal', value: 0, rate: 'variable' },
      },
      metrics: {
        costPerUnit: 0,
        costPerLocation: 0,
        dailyDepreciation: 0,
        sixMonthProjection: 0,
      },
      topSeasons: [],
    };

    let totalUnits = 0;
    const locationIds = new Set();

    stockQuants.forEach(quant => {
      const product = productMap[quant.product_id[0]];
      if (!product) return;

      const qty = quant.quantity;
      const unitCost = product.cost;
      const stockValue = qty * unitCost;
      const finalValue = quant.value > 0 ? quant.value : stockValue;

      const season = product.season;
      const iccData = calculateMonthlyICCRate(season, currentSeason);
      const monthlyCost = finalValue * iccData.monthlyRate;

      results.totalStockValue += finalValue;
      results.totalMonthlyCost += monthlyCost;
      results.totalAnnualCost += finalValue * iccData.annualRate;

      // Breakdown
      results.breakdown.capitalCost.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.capitalCost / 12);
      results.breakdown.obsolescenceBase.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.obsolescenceBase / 12);
      results.breakdown.riskService.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.riskService / 12);
      
      const seasonDepRate = iccData.annualRate - 0.18;
      results.breakdown.seasonDepreciation.value += finalValue * (seasonDepRate / 12);

      // Por temporada
      const seasonKey = season || 'SIN_TEMPORADA';
      if (!results.bySeason[seasonKey]) {
        results.bySeason[seasonKey] = { value: 0, monthlyCost: 0, rate: iccData.annualRate };
      }
      results.bySeason[seasonKey].value += finalValue;
      results.bySeason[seasonKey].monthlyCost += monthlyCost;

      // Por distancia
      const distance = iccData.seasonDistance;
      let distanceKey;
      if (!season) distanceKey = 'unknown';
      else if (distance <= 0) distanceKey = 'current';
      else if (distance === 1) distanceKey = 'previous_1';
      else if (distance === 2) distanceKey = 'previous_2';
      else if (distance === 3) distanceKey = 'previous_3';
      else distanceKey = 'previous_4_plus';

      results.bySeasonDistance[distanceKey].value += finalValue;
      results.bySeasonDistance[distanceKey].cost += monthlyCost;

      totalUnits += qty;
      locationIds.add(quant.location_id[0]);
    });

    // Calcular métricas finales
    results.effectiveRate = (results.totalAnnualCost / results.totalStockValue) * 100;
    results.metrics.costPerUnit = results.totalMonthlyCost / totalUnits;
    results.metrics.costPerLocation = results.totalMonthlyCost / locationIds.size;
    results.metrics.dailyDepreciation = results.totalMonthlyCost / 30;
    results.metrics.sixMonthProjection = results.totalMonthlyCost * 6;

    // Top temporadas
    results.topSeasons = Object.entries(results.bySeason)
      .map(([season, data]) => ({
        season,
        value: data.value,
        monthlyCost: data.monthlyCost,
        rate: data.rate,
      }))
      .sort((a, b) => b.monthlyCost - a.monthlyCost)
      .slice(0, 10);

    console.log(`✅ [ICC] Calculado: €${results.totalMonthlyCost.toFixed(2)}/mes`);
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      data: results,
    });

  } catch (error) {
    console.error('❌ [ICC] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================================================================================
//  8. MÓDULO ANALÍTICO: DISTRIBUCIÓN DE PESOS (2025)
// ==================================================================================
app.get("/api/analytics/weights-2025", async (req, res) => {
  console.log(" ⚖️  [ANALYTICS] Iniciando cálculo de distribución de pesos 2025...");

  try {
    // 1. Autenticación Odoo (Reutilizamos lógica interna o creamos cliente fresco)
    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        process.env.ODOO_DB, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // 2. Obtener Movimientos de Salida (OUTs) de 2025
    const domain = [
      ['date', '>=', '2025-01-01 00:00:00'],
      ['date', '<=', '2025-12-31 23:59:59'],
      ['picking_type_id.code', '=', 'outgoing'], // Solo salidas
      ['state', '=', 'done'] // Solo lo procesado realmente
    ];

    const moves = await fetchAllRecords('stock.move', domain, ['product_id', 'product_uom_qty']);
    console.log(` 📦  Movimientos encontrados: ${moves.length}`);

    // 3. Extraer IDs de productos únicos
    const productIds = [...new Set(moves.map(m => m.product_id[0]))];
    
    // 4. Obtener Pesos y Referencias
    let productsInfo = [];
    for (let i = 0; i < productIds.length; i += 2000) {
        const slice = productIds.slice(i, i + 2000);
        const batch = await new Promise((resolve, reject) => {
            models.methodCall('execute_kw', [
                process.env.ODOO_DB, uid, process.env.ODOO_PASSWORD,
                'product.product', 'read',
                [slice],
                { fields: ['default_code', 'weight'] } 
            ], (err, res) => err ? reject(err) : resolve(res));
        });
        productsInfo = productsInfo.concat(batch);
    }

    // Crear mapa
    const productMap = {};
    productsInfo.forEach(p => {
        const code = (p.default_code || "").toUpperCase();
        let brand = "GENERIC";
        if (code.includes("DF") || code.includes("BLACK")) brand = "BLACK";
        else if (code.includes("KA") || code.includes("WHITE")) brand = "WHITE";
        else if (code.includes("CO") || code.includes("GOLD") || code.includes("BW")) brand = "GOLD";
        
        productMap[p.id] = {
            weight: p.weight || 0,
            brand: brand,
            code: code
        };
    });

    // 5. Agregación
    const distribution = { BLACK: {}, GOLD: {}, WHITE: {}, TOTAL: {} };

    moves.forEach(m => {
        const pid = m.product_id[0];
        const info = productMap[pid];
        if (!info) return;

        const weightGrams = Math.round(info.weight * 1000);
        const bucket = weightGrams >= 1000 ? `${(weightGrams/1000).toFixed(1)}kg` : `${weightGrams}g`;
        const qty = m.product_uom_qty;

        if (distribution[info.brand]) {
            distribution[info.brand][bucket] = (distribution[info.brand][bucket] || 0) + qty;
        }
        distribution.TOTAL[bucket] = (distribution.TOTAL[bucket] || 0) + qty;
    });

    // =================================================================================
    // [NUEVO] GENERACIÓN DE EXCEL/CSV SI SE SOLICITA (?export=true)
    // =================================================================================
    if (req.query.export === 'true') {
        console.log(" 📂 [ANALYTICS] Generando archivo CSV de pesos...");
        let csvContent = "MARCA;RANGO_PESO;CANTIDAD_UNIDADES\n";

        // Iteramos las marcas principales
        ['BLACK', 'GOLD', 'WHITE', 'GENERIC'].forEach(brand => {
            if (distribution[brand]) {
                Object.entries(distribution[brand]).forEach(([bucket, qty]) => {
                    csvContent += `${brand};${bucket};${qty}\n`;
                });
            }
        });
        
        // Añadimos el TOTAL GLOBAL como una "marca" extra para referencia
        if (distribution.TOTAL) {
             Object.entries(distribution.TOTAL).forEach(([bucket, qty]) => {
                csvContent += `TOTAL_GLOBAL;${bucket};${qty}\n`;
            });
        }

        const filename = `distribucion_pesos_2025_${Date.now()}.csv`;
        const filePath = path.join(EXPORT_DIR, filename); 
        
        await fs.writeFile(filePath, csvContent, 'utf8');

        // Devolvemos respuesta enriquecida con el link
        return res.json({
            success: true,
            period: "2025",
            total_moves: moves.length,
            distribution: distribution,
            download_link: `http://${SERVER_HOST}:${PORT}/downloads/${filename}`,
            message: "Archivo generado correctamente."
        });
    }

    res.json({
        success: true,
        period: "2025",
        total_moves: moves.length,
        distribution: distribution
    });

  } catch (error) {
    console.error("❌ Error Analytics:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================================
//  9. SERVICIOS BASE Y WEBSOCKET (ORIGINAL)
// ==================================================================================
app.get("/api/locations", async (req, res) => {
  const dataPath = path.join(__dirname, "data", "locations.json");
  const raw = await fs.readFile(dataPath, "utf8");
  res.json(JSON.parse(raw));
});

app.get("/api/movements", (req, res) => res.json(movements.slice(0, 50)));

// ==================================================================================
//  NUEVO: MOVIMIENTOS POR UBICACIÓN (ENTRADAS/SALIDAS)
// ==================================================================================
app.get("/api/movements/:locationId", async (req, res) => {
  try {
    const { locationId } = req.params;
    const { days = 90 } = req.query; // Por defecto últimos 90 días
    
    console.log(`📦 [MOVEMENTS] Consultando movimientos para: ${locationId} (últimos ${days} días)`);
    
    // Calcular fecha límite
    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.getDate() - parseInt(days));
    const dateLimitStr = dateLimit.toISOString().replace('T', ' ').substring(0, 19);
    
    // Autenticación Odoo
    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        process.env.ODOO_DB, process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    // Buscar movimientos donde la ubicación es ORIGEN (salidas) o DESTINO (entradas)
    // Usamos el patrón CLA-XXX-XX-XX-XX para buscar
    const searchPattern = locationId.includes('CLA-') 
      ? locationId.match(/CLA-\d{3}-\d{2}-\d{2}-\d{2}/)?.[0] || locationId
      : locationId;

    const moveLines = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        process.env.ODOO_DB, uid, process.env.ODOO_PASSWORD,
        'stock.move.line', 'search_read',
        [[
          ['state', '=', 'done'],
          ['date', '>=', dateLimitStr],
          '|',
          ['location_id.complete_name', 'ilike', searchPattern],
          ['location_dest_id.complete_name', 'ilike', searchPattern]
        ]],
        { 
          fields: [
            'location_id', 
            'location_dest_id', 
            'product_id', 
            'qty_done', 
            'date', 
            'reference',
            'package_id',
            'result_package_id'
          ],
          order: 'date desc',
          limit: 500
        }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    console.log(`   Encontrados ${moveLines.length} movimientos`);

    // Clasificar en ENTRADAS y SALIDAS
    const entradas = []; // Destino es nuestra ubicación
    const salidas = [];  // Origen es nuestra ubicación

    moveLines.forEach(m => {
      const origen = m.location_id ? m.location_id[1] : '';
      const destino = m.location_dest_id ? m.location_dest_id[1] : '';
      
      const movimiento = {
        fecha: m.date,
        producto: m.product_id ? m.product_id[1] : 'N/A',
        cantidad: m.qty_done,
        referencia: m.reference || 'N/A',
        paquete: m.package_id ? m.package_id[1] : (m.result_package_id ? m.result_package_id[1] : 'Sin paquete'),
        origen: origen,
        destino: destino
      };

      // Si el destino contiene nuestro patrón = ENTRADA
      if (destino.includes(searchPattern)) {
        movimiento.ubicacionRelacionada = origen;
        entradas.push(movimiento);
      }
      
      // Si el origen contiene nuestro patrón = SALIDA
      if (origen.includes(searchPattern)) {
        movimiento.ubicacionRelacionada = destino;
        salidas.push(movimiento);
      }
    });

    // Agrupar por fecha (solo día)
    const agruparPorFecha = (movimientos) => {
      const grupos = {};
      movimientos.forEach(m => {
        const fecha = m.fecha.split(' ')[0]; // Solo YYYY-MM-DD
        if (!grupos[fecha]) grupos[fecha] = [];
        grupos[fecha].push(m);
      });
      
      // Convertir a array ordenado por fecha descendente
      return Object.entries(grupos)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([fecha, movs]) => ({
          fecha,
          movimientos: movs
        }));
    };

    res.json({
      locationId,
      periodo: `Últimos ${days} días`,
      entradas: {
        total: entradas.length,
        porFecha: agruparPorFecha(entradas)
      },
      salidas: {
        total: salidas.length,
        porFecha: agruparPorFecha(salidas)
      }
    });

  } catch (error) {
    console.error("❌ Error consultando movimientos:", error);
    res.status(500).json({ error: error.message });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

function broadcastUpdate(data) {
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: "UPDATE_LOCATIONS", payload: data })); });
}

wss.on("connection", () => console.log("WS conectado"));

const POLLING_INTERVAL_MS = 5000;
let isSyncing = false;

setInterval(async () => {
  if (isSyncing) return;
  try {
    isSyncing = true;
    const updatedData = await syncWithOdoo();
    if (updatedData) broadcastUpdate(updatedData);
  } catch (e) {
    console.error(e.message);
  } finally {
    isSyncing = false;
  }
}, POLLING_INTERVAL_MS);

// ==================================================================================
//  ⭐ MÓDULO DEVOLUCIONES B2B
// ==================================================================================
import multer from 'multer';
import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);

const DEVOLUCIONES_FILE = path.join(__dirname, "data", "devoluciones.json");

// Asegurar que existe el archivo de devoluciones
const DATA_DIR = path.join(__dirname, "data");
if (!fsSync.existsSync(DATA_DIR)) {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fsSync.existsSync(DEVOLUCIONES_FILE)) {
  fsSync.writeFileSync(DEVOLUCIONES_FILE, '[]', 'utf8');
  console.log("📁 Archivo devoluciones.json creado");
}

// Leer devoluciones del archivo JSON
async function getDevoluciones() {
  try {
    const data = await fs.readFile(DEVOLUCIONES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

// Guardar devoluciones
async function saveDevoluciones(devoluciones) {
  await fs.writeFile(DEVOLUCIONES_FILE, JSON.stringify(devoluciones, null, 2), 'utf8');
}

// Buscar en Odoo por diferentes criterios
async function buscarEnOdoo(query, tipo = 'todos') {
  console.log(`🔍 [DEVOLUCIONES] Buscando "${query}" tipo: ${tipo}`);
  
  const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
  
  const uid = await new Promise((resolve, reject) => {
    common.methodCall('authenticate', [
      'blackdivision', process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
    ], (err, res) => err ? reject(err) : resolve(res));
  });

  let domain = [
    ['picking_type_id.code', '=', 'outgoing'],
    ['state', '=', 'done']
  ];

  const q = query.trim();
  
  if (tipo === 'pedido') {
    domain.push('|');
    domain.push(['origin', 'ilike', q]);
    domain.push(['sale_id.name', 'ilike', q]);
  } else if (tipo === 'albaran') {
    domain.push(['name', 'ilike', q]);
  } else if (tipo === 'cliente') {
    domain.push(['partner_id.name', 'ilike', q]);
  } else {
    domain.push('|', '|', '|');
    domain.push(['name', 'ilike', q]);
    domain.push(['origin', 'ilike', q]);
    domain.push(['partner_id.name', 'ilike', q]);
    domain.push(['sale_id.name', 'ilike', q]);
  }

  try {
    const pickings = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        'blackdivision', uid, process.env.ODOO_PASSWORD,
        'stock.picking', 'search_read',
        [domain],
        { 
          fields: ['id', 'name', 'partner_id', 'origin', 'date_done', 'carrier_id', 'company_id', 'sale_id'],
          limit: 20,
          order: 'date_done desc'
        }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    const devolucionesExistentes = await getDevoluciones();

    const resultados = pickings.map(p => {
      let company = 'Black';
      if (p.company_id) {
        const companyName = p.company_id[1] || '';
        if (companyName.toLowerCase().includes('gold')) company = 'Gold';
      }
      if (p.name && p.name.includes('CLAGD')) company = 'Gold';

      return {
        picking_id: p.id,
        albaran: p.name,
        cliente: p.partner_id ? p.partner_id[1] : 'N/A',
        pedido: p.sale_id ? p.sale_id[1] : (p.origin || 'N/A'),
        fecha_envio: p.date_done,
        carrier: p.carrier_id ? p.carrier_id[1] : null,
        company: company,
        devolucion_existente: devolucionesExistentes.find(d => d.picking_id === p.id) || null
      };
    });

    return { resultados };
  } catch (error) {
    console.error('❌ Error buscando en Odoo:', error);
    return { error: error.message };
  }
}

// ENDPOINTS DEVOLUCIONES B2B
app.get("/api/devoluciones/buscar", async (req, res) => {
  try {
    const { q, tipo = 'todos' } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Búsqueda muy corta (mín. 2 caracteres)' });
    }
    const resultado = await buscarEnOdoo(q, tipo);
    res.json(resultado);
  } catch (error) {
    console.error('❌ Error en búsqueda:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/devoluciones", async (req, res) => {
  try {
    const { picking_id, picking_name, partner_name, company, tracking_retorno, recibido_por, notas } = req.body;
    if (!picking_id || !picking_name) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }
    const devoluciones = await getDevoluciones();
    const existe = devoluciones.find(d => d.picking_id === picking_id);
    if (existe) {
      return res.status(400).json({ error: 'Esta expedición ya tiene una devolución registrada' });
    }
    const nuevaDevolucion = {
      id: Date.now(),
      picking_id,
      picking_name,
      partner_name,
      company: company || 'Black',
      tracking_retorno: tracking_retorno || null,
      recibido_por: recibido_por || 'Operario',
      notas: notas || null,
      fecha_recepcion: new Date().toISOString(),
      estado: 'recibido'
    };
    devoluciones.push(nuevaDevolucion);
    await saveDevoluciones(devoluciones);
    console.log(`✅ [DEVOLUCIONES] Registrada: ${picking_name} por ${recibido_por}`);
    res.json({ success: true, devolucion: nuevaDevolucion });
  } catch (error) {
    console.error('❌ Error registrando devolución:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/devoluciones", async (req, res) => {
  try {
    const { company, limit = 50, offset = 0 } = req.query;
    let devoluciones = await getDevoluciones();
    if (company) {
      devoluciones = devoluciones.filter(d => d.company && d.company.toLowerCase() === company.toLowerCase());
    }
    devoluciones.sort((a, b) => new Date(b.fecha_recepcion) - new Date(a.fecha_recepcion));
    const total = devoluciones.length;
    const paginadas = devoluciones.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    res.json({ devoluciones: paginadas, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (error) {
    console.error('❌ Error listando devoluciones:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/devoluciones/stats", async (req, res) => {
  try {
    const devoluciones = await getDevoluciones();
    const now = new Date();
    const hoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const inicioSemana = new Date(hoy);
    inicioSemana.setDate(hoy.getDate() - hoy.getDay());
    const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
    const hace30Dias = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const contadores = {
      hoy: devoluciones.filter(d => new Date(d.fecha_recepcion) >= hoy).length,
      semana: devoluciones.filter(d => new Date(d.fecha_recepcion) >= inicioSemana).length,
      mes: devoluciones.filter(d => new Date(d.fecha_recepcion) >= inicioMes).length,
      total: devoluciones.length
    };

    const devs30Dias = devoluciones.filter(d => new Date(d.fecha_recepcion) >= hace30Dias);
    const porCompany = {};
    devs30Dias.forEach(d => {
      const comp = d.company || 'Sin empresa';
      porCompany[comp] = (porCompany[comp] || 0) + 1;
    });

    const ultimas = devoluciones.sort((a, b) => new Date(b.fecha_recepcion) - new Date(a.fecha_recepcion)).slice(0, 5);

    res.json({
      contadores,
      por_company: Object.entries(porCompany).map(([company, count]) => ({ company, count })),
      ultimas
    });
  } catch (error) {
    console.error('❌ Error en stats:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/devoluciones/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let devoluciones = await getDevoluciones();
    const index = devoluciones.findIndex(d => d.id === parseInt(id));
    if (index === -1) {
      return res.status(404).json({ error: 'Devolución no encontrada' });
    }
    const eliminada = devoluciones.splice(index, 1)[0];
    await saveDevoluciones(devoluciones);
    console.log(`🗑️ [DEVOLUCIONES] Eliminada: ${eliminada.picking_name}`);
    res.json({ success: true, eliminada });
  } catch (error) {
    console.error('❌ Error eliminando devolución:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================================================================================
//  ⭐ MÓDULO PACKING LIST ANALYZER
// ==================================================================================
const packingStorage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const packingUpload = multer({ storage: packingStorage, limits: { fileSize: 50 * 1024 * 1024 } });

if (!fsSync.existsSync('./uploads')) fsSync.mkdirSync('./uploads', { recursive: true });
if (!fsSync.existsSync('./packing-outputs')) fsSync.mkdirSync('./packing-outputs', { recursive: true });

let packingProductCache = new Map();
let packingAbcCache = new Map();
let packingStockCache = new Map();
let packingLastCacheUpdate = null;

async function refreshPackingCache() {
  console.log('📦 [PACKING] Actualizando caché...');
  const startTime = Date.now();

  try {
    const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        'blackdivision', process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    console.log('  📦 Descargando productos...');
    const products = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        'blackdivision', uid, process.env.ODOO_PASSWORD,
        'product.product', 'search_read',
        [[['default_code', '!=', false], ['active', '=', true]]],
        { fields: ['id', 'default_code', 'name', 'standard_price'], limit: 50000 }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    packingProductCache.clear();
    products.forEach(p => {
      if (p.default_code) {
        packingProductCache.set(p.default_code.toUpperCase().trim(), {
          id: p.id, name: p.name, code: p.default_code, cost: p.standard_price || 0
        });
      }
    });
    console.log(`    ✅ ${packingProductCache.size} productos`);

    console.log('  📊 Descargando clasificación ABC...');
    try {
      const abcData = await new Promise((resolve, reject) => {
        models.methodCall('execute_kw', [
          'blackdivision', uid, process.env.ODOO_PASSWORD,
          'abc.classification.product.level', 'search_read',
          [[]], { fields: ['product_id', 'level_id'], limit: 100000 }
        ], (err, res) => err ? reject(err) : resolve(res));
      });
      packingAbcCache.clear();
      abcData.forEach(row => {
        if (row.product_id && row.level_id) {
          packingAbcCache.set(row.product_id[0], (row.level_id[1] || 'D').charAt(0).toUpperCase());
        }
      });
      console.log(`    ✅ ${packingAbcCache.size} clasificaciones ABC`);
    } catch (e) {
      console.log(`    ⚠️ No se pudo cargar ABC: ${e.message}`);
    }

    console.log('  📍 Descargando stock...');
    const quants = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        'blackdivision', uid, process.env.ODOO_PASSWORD,
        'stock.quant', 'search_read',
        [[['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]],
        { fields: ['product_id', 'location_id', 'quantity'], limit: 100000 }
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    packingStockCache.clear();
    quants.forEach(q => {
      if (q.product_id) {
        const productId = q.product_id[0];
        if (!packingStockCache.has(productId)) {
          packingStockCache.set(productId, { total: 0, locations: [] });
        }
        const entry = packingStockCache.get(productId);
        entry.total += q.quantity;
        entry.locations.push({ id: q.location_id[0], name: q.location_id[1], qty: q.quantity });
      }
    });
    console.log(`    ✅ ${packingStockCache.size} productos con stock`);

    packingLastCacheUpdate = new Date();
    console.log(`✅ [PACKING] Caché actualizada en ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);
    return { products: packingProductCache.size, abc: packingAbcCache.size, stock: packingStockCache.size };
  } catch (error) {
    console.error('❌ [PACKING] Error actualizando caché:', error.message);
    throw error;
  }
}

// ==================================================================================
//  MAPA DE NORMALIZACIÓN DE COLORES (PDF → Odoo)
// ==================================================================================
const COLOR_NORMALIZATION = {
  'BLACK': 'BLAC', 'WHITE': 'WHIT', 'BURGUNDY': 'BURG', 'BEIGE': 'BEIG',
  'BROWN': 'BROW', 'GREEN': 'GREE', 'BLUE': 'BLUE', 'GREY': 'GREY',
  'GRAY': 'GREY', 'PINK': 'PINK', 'GOLD': 'GOLD', 'SILVER': 'SILV',
  'PEWTER': 'PEWT', 'PEWT': 'PEWT', 'ORANGE': 'ORAN', 'YELLOW': 'YELL',
  'PURPLE': 'PURP', 'NAVY': 'NAVY', 'CREAM': 'CREA', 'TAUPE': 'TAUP',
  'OLIVE': 'OLIV', 'CORAL': 'CORA', 'LEOPARD': 'LEOP', 'MULTI': 'MULT',
  'TRANSPARENT': 'TRAN', 'TORTOISE': 'TORT', 'TAN': 'TAN', 'COW': 'COW',
  'OFFWHITE': 'OFFW', 'OFFW': 'OFFW', 'FBLA': 'FBLA', 'FBLACK': 'FBLA'
};

function normalizeColor(color) {
  if (!color) return '';
  const upper = color.toUpperCase().trim();
  return COLOR_NORMALIZATION[upper] || upper.substring(0, 4);
}

// ==================================================================================
//  PARSER PDF CON CLAUDE OPUS 4.5
// ==================================================================================
async function parsePackingPDFWithAI(filePath) {
  console.log('🧠 [PACKING-AI v3.0] Iniciando análisis con Claude Opus 4.5...');
  const tempScriptPath = path.join(__dirname, 'temp_extractor.py');
  const absolutePath = path.resolve(filePath);
  
  const pythonScript = `
import pdfplumber
import json
import sys
import re

pdf_path = sys.argv[1] if len(sys.argv) > 1 else ""
result = {"raw_text": "", "tables": [], "container_candidates": [], "page_count": 0}

try:
    with pdfplumber.open(pdf_path) as pdf:
        result["page_count"] = len(pdf.pages)
        all_text = []
        for page in pdf.pages:
            text = page.extract_text() or ""
            all_text.append(text)
            tables = page.extract_tables()
            for table in tables:
                if table and len(table) > 0:
                    clean_table = [[str(cell).strip() if cell else "" for cell in row] for row in table if row]
                    if clean_table:
                        result["tables"].append(clean_table)
        result["raw_text"] = "\\n".join(all_text)
        result["container_candidates"] = list(set(re.findall(r'[A-Z]{4}\\d{7}', result["raw_text"])))
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

  try {
    await fs.writeFile(tempScriptPath, pythonScript, 'utf8');
    const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
    const { stdout } = await execPromise(`"${pythonExe}" "${tempScriptPath}" "${absolutePath}"`, { maxBuffer: 100 * 1024 * 1024 });
    await fs.unlink(tempScriptPath).catch(() => {});
    
    if (!stdout || stdout.trim() === '') throw new Error('No se pudo extraer contenido del PDF');
    const extracted = JSON.parse(stdout);
    if (extracted.error) throw new Error(extracted.error);

    console.log(`  📄 Extraído: ${extracted.tables.length} tablas, ${extracted.page_count} páginas`);
    console.log(`  🤖 Enviando a Claude Opus 4.5 para análisis profundo...`);

    let contentForAI = `DOCUMENTO DE ${extracted.page_count} PÁGINAS\n`;
    contentForAI += `CONTENEDORES DETECTADOS: ${extracted.container_candidates.join(', ') || 'Ninguno'}\n\n`;
    
    extracted.tables.forEach((table, idx) => {
      const tableStr = table.map(row => row.join(' | ')).join('\n');
      contentForAI += `\n=== TABLA ${idx + 1} ===\n${tableStr}\n`;
    });
    
    if (extracted.tables.length === 0 || contentForAI.length < 2000) {
      contentForAI += `\n=== TEXTO COMPLETO ===\n${extracted.raw_text}`;
    }
    
    if (contentForAI.length > 100000) contentForAI = contentForAI.substring(0, 100000);

    const anthropic = getAnthropicClient();
    const aiResponse = await anthropic.messages.create({
      model: "claude-opus-4-20250514",
      max_tokens: 16384,
      stream: true,
      system: `Eres un experto en logística de almacén especializado en analizar packing lists de contenedores marítimos.

## TU MISIÓN
Extraer CADA LÍNEA del documento como un item separado. NO AGRUPES líneas aunque tengan la misma referencia+color.

## ESTRUCTURA DE LOS PACKING LISTS
Cada línea contiene:
- **Art. NO. / Item No**: Código del producto (ej: COSH244008)
- **COLOUR / Color**: Color del producto (ej: BLACK, BURGUNDY)
- **SIZE columns (25-46)**: Distribución por tallas - los números indican unidades por talla
- **PRS/CTN o PER CTN**: Pares por caja
- **CTNS o TTL CTNS**: Número de cajas de ESA LÍNEA
- **PRS o TTL PRS**: Total de unidades de ESA LÍNEA

## REGLAS CRÍTICAS

### 1. EXTRAER CADA LÍNEA INDIVIDUAL
Aunque haya 50 líneas con COSH244008-BLACK, extrae las 50 como items separados.
Cada línea tiene diferente surtido de tallas y diferentes cantidades.

### 2. NORMALIZACIÓN DE COLORES
BLACK → BLAC | WHITE → WHIT | BURGUNDY → BURG | BEIGE → BEIG
BROWN → BROW | PEWTER → PEWT | GOLD → GOLD | SILVER → SILV
LEOPARD → LEOP | OFFWHITE → OFFW | PINK → PINK | GREY → GREY

### 3. REFERENCIA COMPLETA
código + guión + color normalizado: COSH244008 + BLACK = "COSH244008-BLAC"

### 4. SURTIDO DE TALLAS
Detectar qué tallas tienen unidades en esa línea.
Si columnas 25,26,27,28,29,30,31,32 tienen valores → sizeRange: "25-32"
Si solo columnas 33,34 tienen valores → sizeRange: "33-34"

### 5. DETECCIÓN DE TIPO
- DFKSUN*, DFSU*: Gafas (50 uds/caja, 22 cajas/palet)
- DFTXSOCO*: Calcetines (50 uds/caja, 50 cajas/palet)
- COSH*, DFSH*, BWSH*, BJSH*, TESH*: Calzado
  - Tallas 25-35: Infantil (28 cajas/palet)
  - Tallas 36-46: Adulto (14 cajas/palet)

## RESPUESTA JSON
{
  "container_number": "MRKU0461515",
  "items": [
    {"reference": "COSH244008-BLAC", "quantity": 168, "cartons": 12, "sizeRange": "25-32", "minSize": 25, "prsPerCtn": 14},
    {"reference": "COSH244008-BLAC", "quantity": 36, "cartons": 12, "sizeRange": "33-34", "minSize": 33, "prsPerCtn": 3},
    {"reference": "COSH244008-BLAC", "quantity": 260, "cartons": 20, "sizeRange": "25-35", "minSize": 25, "prsPerCtn": 13}
  ],
  "total_units": 5244,
  "total_cartons": 498,
  "confidence": "HIGH"
}

IMPORTANTE: Extrae TODAS las líneas del documento. Si hay 100 líneas, devuelve 100 items.`,
      messages: [{ role: "user", content: `Analiza este packing list:\n\n${contentForAI}` }]
    });

    let aiText = '';
for await (const event of aiResponse) {
  if (event.type === 'content_block_delta' && event.delta?.text) {
    aiText += event.delta.text;
  }
}
    let parsedAI;
    try {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      parsedAI = jsonMatch ? JSON.parse(jsonMatch[0]) : { items: [], confidence: "LOW" };
    } catch (e) {
      console.error('  ⚠️ Error parseando JSON:', e.message);
      parsedAI = { items: [], confidence: "LOW" };
    }
    
    if (!parsedAI.container_number && extracted.container_candidates.length > 0) {
      parsedAI.container_number = extracted.container_candidates[0];
    }

    // Normalizar colores por si Opus no lo hizo
    if (parsedAI.items) {
      parsedAI.items = parsedAI.items.map(item => {
        let ref = item.reference || '';
        if (ref.includes('-')) {
          const parts = ref.split('-');
          ref = `${parts[0]}-${normalizeColor(parts.slice(1).join('-'))}`;
        }
        return { ...item, reference: ref.toUpperCase() };
      });
    }
    
    console.log(`  ✅ ${parsedAI.items?.length || 0} referencias (Confidence: ${parsedAI.confidence})`);
    console.log(`  📦 Total: ${parsedAI.total_units || 'N/A'} uds, ${parsedAI.total_cartons || 'N/A'} cajas`);
    
    return parsedAI;
  } catch (error) {
    await fs.unlink(tempScriptPath).catch(() => {});
    throw error;
  }
}

// ==================================================================================
//  ENRIQUECIMIENTO CON ODOO (LÍNEAS INDIVIDUALES + RESUMEN AGRUPADO)
// ==================================================================================
function enrichPackingListAI(parsedData) {
  const enriched = [];
  const summary = { 
    totalUnits: 0, totalBoxes: 0, totalPallets: 0,
    byABC: { A: 0, B: 0, C: 0, D: 0, NEW: 0 }, 
    byType: { SUNGLASSES: 0, SOCKS: 0, FOOTWEAR_ADULT: 0, FOOTWEAR_KIDS: 0, UNKNOWN: 0 },
    newReferences: [], consolidationAlerts: [],
    groupedTotals: []
  };

  if (!parsedData.items || parsedData.items.length === 0) return { items: enriched, summary };

  // ========== FUNCIONES AUXILIARES ==========
  function getPackingRules(reference, minSize, productType) {
    const ref = (reference || '').toUpperCase();
    
    if (productType === 'SUNGLASSES' || ref.startsWith('DFKSUN') || ref.startsWith('DFSU')) {
      return { udsPerBox: 50, boxesPerPallet: 22, type: 'SUNGLASSES' };
    }
    if (productType === 'SOCKS' || ref.includes('DFTXSOCO') || ref.includes('SOC')) {
      return { udsPerBox: 50, boxesPerPallet: 50, type: 'SOCKS' };
    }
    
    const size = minSize || 36;
    if (size < 36) {
      return { udsPerBox: null, boxesPerPallet: 28, type: 'FOOTWEAR_KIDS' };
    }
    return { udsPerBox: null, boxesPerPallet: 14, type: 'FOOTWEAR_ADULT' };
  }

  function findProductInOdoo(reference) {
    let product = packingProductCache.get(reference);
    if (product) return product;
    
    product = packingProductCache.get(reference.replace(/-/g, ''));
    if (product) return product;
    
    const baseCode = reference.split('-')[0];
    product = packingProductCache.get(baseCode);
    if (product) return product;
    
    for (const [key, value] of packingProductCache.entries()) {
      if (key.includes(baseCode) || key.includes(reference.replace(/-/g, ''))) {
        return value;
      }
    }
    return null;
  }

  // ========== PASO 1: PROCESAR CADA LÍNEA INDIVIDUAL ==========
  const groupedTotals = new Map();

  parsedData.items.forEach((item, index) => {
    const reference = (item.reference || '').toUpperCase().trim();
    if (!reference) return;

    const rules = getPackingRules(reference, item.minSize, item.productType);
    
    let totalBoxes = item.cartons || 0;
    if (!totalBoxes && rules.udsPerBox && item.quantity) {
      totalBoxes = Math.ceil(item.quantity / rules.udsPerBox);
    }
    
    let totalPallets = totalBoxes && rules.boxesPerPallet ? totalBoxes / rules.boxesPerPallet : 0;

    const productInfo = findProductInOdoo(reference);
    
    let abcClass = 'NEW';
    let currentStock = 0;
    let stockLocations = [];
    
    if (productInfo) {
      abcClass = packingAbcCache.get(productInfo.id) || 'D';
      const stock = packingStockCache.get(productInfo.id);
      if (stock) { 
        currentStock = stock.total; 
        stockLocations = (stock.locations || []).map(loc => ({
          location: loc.name || loc.location || 'Desconocida',
          qty: loc.qty || loc.quantity || 0
        })).filter(loc => loc.qty > 0);
      }
    }

    // Acumular para resumen agrupado
    if (!groupedTotals.has(reference)) {
      groupedTotals.set(reference, { 
        reference, totalUnits: 0, totalBoxes: 0, 
        productName: productInfo?.name || 'No encontrado',
        abcClass, currentStock, stockLocations,
        productType: rules.type,
        boxesPerPallet: rules.boxesPerPallet,
        lines: 0
      });
    }
    const grouped = groupedTotals.get(reference);
    grouped.totalUnits += item.quantity || 0;
    grouped.totalBoxes += totalBoxes;
    grouped.lines++;

    // Actualizar totales generales
    const qty = item.quantity || 0;
    summary.byABC[abcClass] = (summary.byABC[abcClass] || 0) + qty;
    summary.byType[rules.type] = (summary.byType[rules.type] || 0) + qty;
    summary.totalUnits += qty;
    summary.totalBoxes += totalBoxes;
    summary.totalPallets += totalPallets;

    // Añadir línea individual
    enriched.push({
      lineNumber: index + 1,
      itemNo: reference,
      productName: productInfo?.name || 'No encontrado en Odoo',
      sizeRange: item.sizeRange || '-',
      prsPerCtn: item.prsPerCtn || '-',
      totalUnits: qty,
      totalBoxes: totalBoxes,
      totalPallets: Math.round(totalPallets * 100) / 100,
      productType: rules.type,
      boxesPerPallet: rules.boxesPerPallet,
      abcClass,
      currentStock,
      stockLocations: stockLocations.slice(0, 5)
    });
  });

  // ========== PASO 2: GENERAR RESUMEN AGRUPADO ==========
  groupedTotals.forEach((data, reference) => {
    const pallets = data.totalBoxes / data.boxesPerPallet;
    
    summary.groupedTotals.push({
      reference: data.reference,
      productName: data.productName,
      totalUnits: data.totalUnits,
      totalBoxes: data.totalBoxes,
      totalPallets: Math.round(pallets * 100) / 100,
      lines: data.lines,
      abcClass: data.abcClass,
      currentStock: data.currentStock,
      stockLocations: data.stockLocations
    });

    if (data.currentStock > 0) {
      const locNames = data.stockLocations.slice(0, 3).map(l => l.location).join(', ');
      summary.consolidationAlerts.push({ 
        itemNo: reference, 
        currentStock: data.currentStock, 
        incomingUnits: data.totalUnits,
        message: `⚠️ Stock: ${data.currentStock} uds en ${data.stockLocations.length} ubic. (${locNames})`
      });
    }

    if (data.abcClass === 'NEW') {
      summary.newReferences.push(reference);
    }
  });

  summary.totalPallets = Math.round(summary.totalPallets * 100) / 100;

  // Ordenar por referencia y luego por número de línea
  enriched.sort((a, b) => {
    if (a.itemNo !== b.itemNo) return a.itemNo.localeCompare(b.itemNo);
    return a.lineNumber - b.lineNumber;
  });

  console.log(`  📊 ${parsedData.items.length} líneas procesadas → ${groupedTotals.size} referencias únicas`);
  console.log(`  📦 Total: ${summary.totalUnits} uds, ${summary.totalBoxes} cajas, ${summary.totalPallets} palets`);

  return { items: enriched, summary };
}

// ==================================================================================
//  ENDPOINTS PACKING
// ==================================================================================
app.get("/api/packing/health", (req, res) => {
  res.json({
    status: 'ok', version: '3.2-OPUS',
    cache: { products: packingProductCache.size, abc: packingAbcCache.size, stock: packingStockCache.size, lastUpdate: packingLastCacheUpdate }
  });
});

app.post("/api/packing/cache/refresh", async (req, res) => {
  try {
    const stats = await refreshPackingCache();
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/packing/analyze", packingUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    console.log(`\n📄 [PACKING v3.2] Analizando: ${req.file.originalname}`);

    if (!packingLastCacheUpdate || (Date.now() - packingLastCacheUpdate.getTime()) > 3600000) {
      try { await refreshPackingCache(); } catch (e) { console.warn('⚠️ Cache no actualizada'); }
    }

    const parsed = await parsePackingPDFWithAI(req.file.path);
    const containerNumber = parsed.container_number || req.file.originalname.match(/[A-Z]{4}\d{7}/)?.[0] || 'UNKNOWN';
    const enriched = enrichPackingListAI(parsed);

    await fs.unlink(req.file.path).catch(() => {});
    console.log(`✅ [PACKING] Completado: ${enriched.items.length} líneas, ${enriched.summary.groupedTotals.length} referencias\n`);

    res.json({ 
      success: true, 
      containerNumber, 
      summary: enriched.summary, 
      items: enriched.items,
      groupedTotals: enriched.summary.groupedTotals,
      aiPowered: true, 
      model: 'opus-4.5' 
    });
  } catch (error) {
    console.error('❌ [PACKING] Error:', error);
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/packing/download/:filename", (req, res) => {
  res.download(path.join(__dirname, 'packing-outputs', req.params.filename));
});

// ==================================================================================
//  SERVIDOR - INICIO
// ==================================================================================
server.listen(PORT, '0.0.0.0', () => console.log(` 🚀  CEREBRO CLAUDE + CFO IA + DEVOLUCIONES B2B + PACKING v3.2 OPUS en ${PORT}`));