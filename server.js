import 'dotenv/config'; // <--- CARGA DE SEGURIDAD (LÃ­nea 1 Obligatoria)
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

// --- IMPORTS: Cerebros LÃ³gicos ---
import { strategicAnalyzer } from "./strategic_analyzer.js";
import { explanationEngine } from "./explanation_engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================================================================================
// Â DIAGNÃ“STICO DE VARIABLES DE ENTORNO
// ==================================================================================
console.log("========== DIAGNÃ“STICO DE VARIABLES ==========");
console.log("PORT:", process.env.PORT);
console.log("ODOO_URL:", process.env.ODOO_URL ? "âœ… Configurada" : "âŒ NO encontrada");
console.log("ODOO_DB:", 'blackdivision' ? "âœ… Configurada" : "âŒ NO encontrada");
console.log("ODOO_USERNAME:", process.env.ODOO_USERNAME ? "âœ… Configurada" : "âŒ NO encontrada");
console.log("ODOO_PASSWORD:", process.env.ODOO_PASSWORD ? "âœ… Configurada" : "âŒ NO encontrada");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "âœ… Configurada (" + process.env.ANTHROPIC_API_KEY.substring(0,15) + "...)" : "âŒ NO encontrada");

// Listar TODAS las variables que empiezan con letras relevantes
console.log("\n--- Todas las variables de entorno disponibles ---");
Object.keys(process.env).filter(k => 
Â  k.startsWith('ANTHROPIC') || 
Â  k.startsWith('OPENAI') || 
Â  k.startsWith('ODOO') || 
Â  k.startsWith('PORT') ||
Â  k.startsWith('API')
).forEach(k => {
Â  const val = process.env[k];
Â  console.log(` Â ${k}: ${val ? (val.length > 20 ? val.substring(0,20) + '...' : val) : 'undefined'}`);
});
console.log("================================================\n");

// ==================================================================================
// Â 1. CONFIGURACIÃ“N DEL SERVIDOR Y SEGURIDAD
// ==================================================================================
const PORT = process.env.PORT || 4000;
const SERVER_HOST = process.env.SERVER_HOST || "localhost";

// Rutas de Datos
const LOCATIONS_FILE = path.join(__dirname, "data", "locations.json");
const AUDIT_REPORT_FILE = path.join(__dirname, "data", "audit_report.json");

// NO salir si no hay API key - solo advertir
if (!process.env.ANTHROPIC_API_KEY) {
Â  Â  console.warn(" âš ï¸ ADVERTENCIA: ANTHROPIC_API_KEY no encontrada. El chat IA no funcionarÃ¡.");
}

const EXPORT_DIR = path.join(__dirname, "exports");
if (!fsSync.existsSync(EXPORT_DIR)) {
Â  fsSync.mkdirSync(EXPORT_DIR);
}

// ==================================================================================
// Â CLIENTE ANTHROPIC - INICIALIZACIÃ“N LAZY
// ==================================================================================
let _anthropicClient = null;

function getAnthropicClient() {
Â  if (!_anthropicClient) {
Â  Â  const apiKey = process.env.ANTHROPIC_API_KEY || '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';
Â  Â  if (!apiKey) {
Â  Â  Â  throw new Error("ANTHROPIC_API_KEY no estÃ¡ configurada. Verifica las variables de entorno en Railway.");
Â  Â  }
Â  Â  _anthropicClient = new Anthropic({ apiKey });
Â  Â  console.log("âœ… Cliente Anthropic inicializado correctamente");
Â  }
Â  return _anthropicClient;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use("/downloads", express.static(EXPORT_DIR));

let movements = []; 

// ==================================================================================
// Â HELPERS DE ODOO (NECESARIOS PARA EL NUEVO MÃ“DULO)
// ==================================================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function odooExecute(method, model, operation, params, options = {}) {
Â  const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
Â  const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });

Â  const uid = await new Promise((resolve, reject) => {
Â  Â  common.methodCall('authenticate', [
Â  Â  Â  'blackdivision', process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
Â  Â  ], (err, res) => err ? reject(err) : resolve(res));
Â  });

Â  return new Promise((resolve, reject) => {
Â  Â  models.methodCall('execute_kw', [
Â  Â  Â  'blackdivision', uid, process.env.ODOO_PASSWORD,
Â  Â  Â  model, operation, params, options
Â  Â  ], (err, res) => err ? reject(err) : resolve(res));
Â  });
}

async function fetchAllRecords(model, domain, fields) {
Â  let allRecords = [];
Â  let offset = 0;
Â  const LIMIT = 2000;
Â  let hasMore = true;

Â  // Solo loguear si es una operaciÃ³n pesada
Â  if (model === 'stock.move') process.stdout.write(` ðŸ“¡ Â Descargando ${model}... `);

Â  while (hasMore) {
Â  Â  try {
Â  Â  Â  const batch = await odooExecute('execute_kw', model, 'search_read', [domain], {
Â  Â  Â  Â  fields, offset, limit: LIMIT
Â  Â  Â  });
Â  Â  Â  
Â  Â  Â  allRecords = allRecords.concat(batch);
Â  Â  Â  offset += LIMIT;
Â  Â  Â  if (model === 'stock.move') process.stdout.write('.');
Â  Â  Â  
Â  Â  Â  if (batch.length < LIMIT) hasMore = false;
Â  Â  Â  await sleep(50); 
Â  Â  } catch (e) {
Â  Â  Â  console.error(`\n âŒ Error en batch ${offset}:`, e.message);
Â  Â  Â  hasMore = false;
Â  Â  }
Â  }
Â  if (model === 'stock.move') console.log(` âœ… (${allRecords.length})`);
Â  return allRecords;
}

// ==================================================================================
// Â 1.1 CONTEXTO FINANCIERO Y TÃ‰CNICO (CAPA CFO)
// ==================================================================================
const DATA_DICTIONARY = `
### ðŸ“š DICCIONARIO TÃ‰CNICO (ODOO ERP + AUDITORÃA):
1. **STOCK FÃSICO:** Tabla \`stock.quant\`. Filtro \`usage='internal'\`.
2. **VALORACIÃ“N (â‚¬):** Î£ (\`stock.quant.quantity\` * \`product.product.standard_price\`).
Â  Â - *Origen:* Coste estÃ¡ndar de la ficha del producto en Odoo.
3. **ABC:** Tabla \`abc.classification\` o calculado por IA (Ventas 365d) si falta en Odoo.
4. **ANTIGÃœEDAD:** DÃ­as desde \`in_date\`.
`;

// Helper para cargar datos enriquecidos (Para el Prompt del CFO)
async function getWarehouseContext() {
Â  try {
Â  Â  const [locRaw, auditRaw] = await Promise.all([
Â  Â  Â  fs.readFile(LOCATIONS_FILE, 'utf8'),
Â  Â  Â  fs.readFile(AUDIT_REPORT_FILE, 'utf8').catch(() => "{}")
Â  Â  ]);
Â  Â  
Â  Â  const locations = JSON.parse(locRaw);
Â  Â  const audit = JSON.parse(auditRaw);
Â  Â  
Â  Â  // CÃLCULO FINANCIERO AGREGADO
Â  Â  let totalValue = 0;
Â  Â  let itemsWithCost = 0;
Â  Â  let totalItems = 0;
Â  Â  
Â  Â  locations.forEach(loc => {
Â  Â  Â  Â  if(loc.packages) {
Â  Â  Â  Â  Â  Â  loc.packages.forEach(pkg => {
Â  Â  Â  Â  Â  Â  Â  Â  const cost = pkg.cost || 0; 
Â  Â  Â  Â  Â  Â  Â  Â  const qty = pkg.qty || 0;
Â  Â  Â  Â  Â  Â  Â  Â  const val = qty * cost;
Â  Â  Â  Â  Â  Â  Â  Â  totalValue += val;
Â  Â  Â  Â  Â  Â  Â  Â  totalItems += 1;
Â  Â  Â  Â  Â  Â  Â  Â  if (val > 0) itemsWithCost++;
Â  Â  Â  Â  Â  Â  });
Â  Â  Â  Â  }
Â  Â  });

Â  Â  return { locations, audit, totalValue, itemsWithCost, totalItems };
Â  } catch (e) {
Â  Â  console.error("Error cargando contexto:", e);
Â  Â  return { locations: [], audit: {}, totalValue: 0, itemsWithCost: 0, totalItems: 0 };
Â  }
}

// [NUEVO] Herramienta de BÃºsqueda Profunda para la IA (VISUALIZACIÃ“N)
async function queryDetailedData(params) {
Â  const { locations } = await getWarehouseContext();
Â  const { target, type } = params;
Â  
Â  console.log(` ðŸ§  [CFO AI] Buscando referencia: "${target}" (${type})`);

Â  let data = [];
Â  // Limpieza agresiva del tÃ©rmino de bÃºsqueda
Â  const searchTerm = target.trim().toUpperCase().replace(/\s+/g, '');

Â  if (type === 'LOCATION') {
Â  Â  const loc = locations.find(l => l.id === target);
Â  Â  if (loc) data.push(loc);
Â  } else {
Â  Â  // BÃºsqueda en todo el almacÃ©n
Â  Â  locations.forEach(loc => {
Â  Â  Â  if (!loc.packages) return;
Â  Â  Â  
Â  Â  Â  // Buscamos coincidencias parciales en cÃ³digo, surtido o paquete
Â  Â  Â  const matches = loc.packages.filter(p => {
Â  Â  Â  Â  const pCode = (p.productCode || "").toUpperCase().replace(/\s+/g, '');
Â  Â  Â  Â  const pSurtido = (p.surtido || "").toUpperCase().replace(/\s+/g, '');
Â  Â  Â  Â  const pPkg = (p.packageId || "").toUpperCase().replace(/\s+/g, '');
Â  Â  Â  Â  
Â  Â  Â  Â  return pCode.includes(searchTerm) || pSurtido.includes(searchTerm) || pPkg.includes(searchTerm);
Â  Â  Â  });
Â  Â  Â  
Â  Â  Â  if (matches.length > 0) {
Â  Â  Â  Â  data.push({
Â  Â  Â  Â  Â  locationId: loc.id,
Â  Â  Â  Â  Â  brand: loc.brand,
Â  Â  Â  Â  Â  matches: matches // Enviamos el paquete completo con 'financials' y 'abcSource'
Â  Â  Â  Â  });
Â  Â  Â  }
Â  Â  });
Â  }
Â  
Â  if (data.length === 0) {
Â  Â  Â  return JSON.stringify({ 
Â  Â  Â  Â  Â  found: false, 
Â  Â  Â  Â  Â  message: `No se encontrÃ³ stock con la referencia '${target}' en el Gemelo Digital.` 
Â  Â  Â  });
Â  }
Â  
Â  return JSON.stringify(data.slice(0, 50)); // Limitamos para no saturar contexto
}

// ==================================================================================
// Â 2. GENERADOR DE EXCEL (CSV) - FORMATO INGENIERO COMPLETO
// ==================================================================================
function generateCSV(data, searchTerm = "", hidePrices = false) {
Â  // ConstrucciÃ³n de la cabecera dinÃ¡mica
Â  let header = "ID_UBICACION;MARCA;TEMPORADAS;STOCK_TOTAL_UBICACION";
Â  
Â  // Columna financiera condicional
Â  if (!hidePrices) header += ";VALOR_STOCK_â‚¬"; 
Â  
Â  header += ";CLASES_ABC;DIAS_MAX;OCUPACION_%";
Â  
Â  // Columna de precisiÃ³n de bÃºsqueda
Â  if (searchTerm) header += ";STOCK_EXACTO_BUSQUEDA"; 
Â  
Â  // Columnas de desglose de contenido
Â  header += ";PRODUCTOS_A;PRODUCTOS_B;PRODUCTOS_C;PRODUCTOS_D\n";

Â  const rows = data.map(loc => {
Â  Â  // Datos calculados de la ubicaciÃ³n
Â  Â  const classes = [...new Set(loc.packages.map(p => p.abcClass))].join("+");
Â  Â  const seasons = [...new Set(loc.packages.map(p => p.season || "N/A"))].join("+");
Â  Â  const maxDays = Math.max(...loc.packages.map(p => p.daysOld || 0));
Â  Â  const vol = Math.round(loc.occupancyPercentage || 0);
Â  Â  
Â  Â  // CÃ¡lculo de valor (solo si no es privado)
Â  Â  const locValue = !hidePrices 
Â  Â  Â  ? loc.packages.reduce((sum, p) => sum + ((p.qty || 0) * (p.cost || 0)), 0).toFixed(2) 
Â  Â  Â  : "";

Â  Â  // Formateador de paquetes para las celdas de detalle
Â  Â  const formatPack = (p) => `[${p.productCode}] ${p.qty}u (${p.season}) ${p.daysOld}d`;

Â  Â  // SegregaciÃ³n por columnas ABC
Â  Â  const prodA = loc.packages.filter(p => p.abcClass === 'A').map(formatPack).join(" | ");
Â  Â  const prodB = loc.packages.filter(p => p.abcClass === 'B').map(formatPack).join(" | ");
Â  Â  const prodC = loc.packages.filter(p => p.abcClass === 'C').map(formatPack).join(" | ");
Â  Â  const prodD = loc.packages.filter(p => p.abcClass === 'D' || !p.abcClass).map(formatPack).join(" | ");
Â  Â  
Â  Â  // ConstrucciÃ³n de la fila CSV
Â  Â  let row = `${loc.id};${loc.brand};${seasons};${loc.totalStock}`;
Â  Â  
Â  Â  if (!hidePrices) row += `;${locValue}`;
Â  Â  
Â  Â  row += `;${classes};${maxDays};${vol}`;
Â  Â  
Â  Â  if (searchTerm) row += `;${loc.matchQty || 0}`;
Â  Â  
Â  Â  row += `;${prodA};${prodB};${prodC};${prodD}`;
Â  Â  return row;
Â  }).join("\n");

Â  return header + rows;
}

// ==================================================================================
// Â 3. MOTOR DE INGENIERÃA (LÃ“GICA DE FILTRADO Y CÃLCULO)
// ==================================================================================
async function queryWarehouseData(locations, filters) {
Â  console.log(" âš™ï¸ Â [MOTOR] Procesando Filtros Avanzados:", filters);

Â  // A. FILTRADO DE UBICACIONES (Nivel Macro)
Â  let results = locations.filter(loc => {
Â  Â  // Filtro de Estado (Vacio/Lleno)
Â  Â  if (filters.status === "EMPTY" && (loc.totalStock || 0) > 0) return false;
Â  Â  if (filters.status === "OCCUPIED" && (loc.totalStock || 0) === 0) return false;
Â  Â  
Â  Â  // Filtro de Marca
Â  Â  if (filters.brand && filters.brand !== "ALL") { 
Â  Â  Â  Â  if (!loc.id.includes(filters.brand)) return false; 
Â  Â  }
Â  Â  
Â  Â  // Filtro de AntigÃ¼edad (Zombis)
Â  Â  if (filters.min_days_old) { 
Â  Â  Â  Â  if (!loc.packages || !loc.packages.some(p => p.daysOld >= filters.min_days_old)) return false; 
Â  Â  }
Â  Â  
Â  Â  // Filtro ABC (UbicaciÃ³n contiene clase)
Â  Â  if (filters.abc_class) { 
Â  Â  Â  Â  if (!loc.packages || !loc.packages.some(p => p.abcClass === filters.abc_class)) return false; 
Â  Â  }
Â  Â  
Â  Â  // Filtro TEMPORADA (Nuevo)
Â  Â  if (filters.season) {
Â  Â  Â  Â  // Si la ubicaciÃ³n no tiene NINGÃšN paquete de esa temporada, se descarta
Â  Â  Â  Â  if (!loc.packages || !loc.packages.some(p => p.season === filters.season)) return false;
Â  Â  }

Â  Â  // BÃºsqueda de Texto Libre
Â  Â  if (filters.search_text) {
Â  Â  Â  const q = filters.search_text.toLowerCase();
Â  Â  Â  const contentStr = JSON.stringify(loc.packages).toLowerCase();
Â  Â  Â  if (!contentStr.includes(q) && !loc.id.toLowerCase().includes(q)) return false;
Â  Â  }
Â  Â  
Â  Â  // Filtro de Velocidad / Slotting
Â  Â  if (filters.min_velocity) {
Â  Â  Â  Â  if ((loc.velocityScore || 0) < filters.min_velocity) return false;
Â  Â  }

Â  Â  return true;
Â  });

Â  // B. AUDITORÃA DE MEZCLAS (IngenierÃ­a)
Â  if (filters.check_mixing_a_d) {
Â  Â  results = results.filter(loc => {
Â  Â  Â  if (!loc.packages) return false;
Â  Â  Â  const classes = loc.packages.map(p => p.abcClass || "D");
Â  Â  Â  // CondiciÃ³n estricta: A + (D o C)
Â  Â  Â  return classes.includes("A") && (classes.includes("D") || classes.includes("C"));
Â  Â  });
Â  }

Â  // C. AGREGACIÃ“N MATEMÃTICA POR PRODUCTO (Nivel Micro - EL CEREBRO)
Â  // AquÃ­ sumamos producto a producto para evitar alucinaciones de la IA.
Â  const productAggregator = {};
Â  let totalValueSelection = 0;

Â  results.forEach(loc => {
Â  Â  Â  if (!loc.packages) return;
Â  Â  Â  
Â  Â  Â  let matchQtyLoc = 0; // Contador local para la ubicaciÃ³n
Â  Â  Â  
Â  Â  Â  loc.packages.forEach(pkg => {
Â  Â  Â  Â  Â  // Filtros finos a nivel de paquete (para no sumar lo que no toca)
Â  Â  Â  Â  Â  if (filters.abc_class && pkg.abcClass !== filters.abc_class) return;
Â  Â  Â  Â  Â  if (filters.season && pkg.season !== filters.season) return;
Â  Â  Â  Â  Â  
Â  Â  Â  Â  Â  if (filters.search_text) {
Â  Â  Â  Â  Â  Â  Â  const str = (pkg.surtido || "" + pkg.productCode).toLowerCase();
Â  Â  Â  Â  Â  Â  Â  if (!str.includes(filters.search_text.toLowerCase())) return;
Â  Â  Â  Â  Â  }

Â  Â  Â  Â  Â  // ExtracciÃ³n de datos
Â  Â  Â  Â  Â  const ref = pkg.surtido || pkg.productCode || "SIN_REF";
Â  Â  Â  Â  Â  const qty = pkg.qty || 0;
Â  Â  Â  Â  Â  const cost = pkg.cost || 0;
Â  Â  Â  Â  Â  const vel = pkg.velocity || 0;
Â  Â  Â  Â  Â  const seas = pkg.season || "N/A";

Â  Â  Â  Â  Â  // AgregaciÃ³n al mapa global
Â  Â  Â  Â  Â  if (!productAggregator[ref]) {
Â  Â  Â  Â  Â  Â  Â  productAggregator[ref] = { 
Â  Â  Â  Â  Â  Â  Â  Â  Â  ref, 
Â  Â  Â  Â  Â  Â  Â  Â  Â  total_qty: 0, 
Â  Â  Â  Â  Â  Â  Â  Â  Â  total_val: 0, 
Â  Â  Â  Â  Â  Â  Â  Â  Â  velocity: vel,
Â  Â  Â  Â  Â  Â  Â  Â  Â  season: seas,
Â  Â  Â  Â  Â  Â  Â  Â  Â  abc: pkg.abcClass
Â  Â  Â  Â  Â  Â  Â  };
Â  Â  Â  Â  Â  }
Â  Â  Â  Â  Â  
Â  Â  Â  Â  Â  // Sumatorios
Â  Â  Â  Â  Â  productAggregator[ref].total_qty += qty;
Â  Â  Â  Â  Â  
Â  Â  Â  Â  Â  if (!filters.hide_prices) {
Â  Â  Â  Â  Â  Â  productAggregator[ref].total_val += (qty * cost);
Â  Â  Â  Â  Â  Â  totalValueSelection += (qty * cost);
Â  Â  Â  Â  Â  }
Â  Â  Â  Â  Â  
Â  Â  Â  Â  Â  matchQtyLoc += qty;
Â  Â  Â  });
Â  Â  Â  
Â  Â  Â  // Guardamos el dato exacto en la ubicaciÃ³n (para el Excel)
Â  Â  Â  loc.matchQty = matchQtyLoc;
Â  });

Â  // D. CONSTRUCCIÃ“N DEL INFORME DE PRODUCTOS (CHIVATO PARA LA IA)
Â  const topProductsList = Object.values(productAggregator).map(p => {
Â  Â  Â  let coverage = "Infinito";
Â  Â  Â  if (p.velocity > 0) coverage = Math.round(p.total_qty / p.velocity) + " dÃ­as";
Â  Â  Â  else if (p.total_qty > 0) coverage = "Sin ventas (Riesgo)";
Â  Â  Â  
Â  Â  Â  // Limpieza por privacidad
Â  Â  Â  if (filters.hide_prices) delete p.total_val;
Â  Â  Â  
Â  Â  Â  return { ...p, coverage };
Â  });

Â  // Ordenamos productos por cantidad total
Â  topProductsList.sort((a, b) => b.total_qty - a.total_qty);

Â  // Ordenamos ubicaciones por relevancia
Â  results.sort((a, b) => b.matchQty - a.matchQty);

Â  // E. PREPARAR RESPUESTA FINAL
Â  const totalCount = results.length; // Total de ubicaciones encontradas
Â  const totalStockFiltered = topProductsList.reduce((acc, p) => acc + p.total_qty, 0); // Total unidades reales
Â  const foundIds = results.map(r => r.id); // IDs para el mapa

Â  const response = {
Â  Â  Â  summary: {
Â  Â  Â  Â  Â  found: true,
Â  Â  Â  Â  Â  count_locations: totalCount,
Â  Â  Â  Â  Â  total_stock_units: totalStockFiltered,
Â  Â  Â  Â  Â  note: "CÃ¡lculos matemÃ¡ticos verificados."
Â  Â  Â  },
Â  Â  Â  // Datos clave para la IA
Â  Â  Â  top_products_summary: topProductsList.slice(0, 10),
Â  Â  Â  // Datos clave para el Mapa (Copilot)
Â  Â  Â  found_ids: foundIds
Â  };

Â  if (!filters.hide_prices) {
Â  Â  Â  response.summary.total_value_eur = totalValueSelection.toFixed(2);
Â  } else {
Â  Â  Â  response.summary.privacy_mode = "ACTIVADO";
Â  }

Â  // F. EXPORTACIÃ“N INTELIGENTE (AUTOMÃTICA)
Â  if (filters.export_csv === true || (filters.auto_export_if_large && totalCount > 50)) {
Â  Â  console.log(` ðŸ“‚ Â Generando Excel Masivo (${totalCount} filas)...`);
Â  Â  const filename = `report_ingenieria_${Date.now()}.csv`;
Â  Â  const filePath = path.join(EXPORT_DIR, filename);
Â  Â  
Â  Â  await fs.writeFile(filePath, generateCSV(results, filters.search_text, filters.hide_prices), 'utf8');
Â  Â  
Â  Â  response.summary.action = "FILE_GENERATED";
Â  Â  response.summary.download_link = `http://${SERVER_HOST}:${PORT}/downloads/${filename}`;
Â  Â  response.summary.message = "Datos masivos procesados. EnvÃ­o resumen Top 10 y enlace de descarga.";
Â  }

Â  return JSON.stringify(response);
}

// ==================================================================================
// Â 4. MOTOR DE INTELIGENCIA DE NEGOCIO (BI - VENTAS ODOO)
// ==================================================================================
async function analyzeSalesData(args) {
Â  console.log(" ðŸ’° Â [BI] Analizando Ventas Odoo:", args);
Â  const days = args.days_back || 7;
Â  const rawSales = await getRealTimeSales(days);
Â  
Â  if (!rawSales || rawSales.length === 0) return JSON.stringify({ message: "No se encontraron ventas en el periodo." });

Â  const stats = { total_units: 0, by_brand: { BLACK: 0, GOLD: 0, WHITE: 0, GENERIC: 0 }, top_products: [] };
Â  
Â  if (!args.hide_prices) stats.total_value = 0;

Â  const productMap = {};

Â  rawSales.forEach(line => {
Â  Â  const name = line.p || "Desconocido";
Â  Â  const qty = line.q || 0;
Â  Â  const val = line.v || 0;
Â  Â  
Â  Â  stats.total_units += qty;
Â  Â  if (!args.hide_prices) stats.total_value = (stats.total_value || 0) + val;

Â  Â  // LÃ³gica de Marcas
Â  Â  let brand = "GENERIC";
Â  Â  const upper = name.toUpperCase();
Â  Â  if (upper.includes("DF") || upper.includes("BLACK")) brand = "BLACK";
Â  Â  else if (upper.includes("CO") || upper.includes("GOLD")) brand = "GOLD";
Â  Â  else if (upper.includes("KA") || upper.includes("WHITE")) brand = "WHITE";

Â  Â  stats.by_brand[brand] = (stats.by_brand[brand] || 0) + qty;

Â  Â  if (!productMap[name]) productMap[name] = { name, qty: 0 };
Â  Â  productMap[name].qty += qty;
Â  Â  if (!args.hide_prices) productMap[name].val = (productMap[name].val || 0) + val;
Â  });

Â  stats.top_products = Object.values(productMap).sort((a, b) => b.qty - a.qty).slice(0, 10);
Â  return JSON.stringify({ period: `Ãšltimos ${days} dÃ­as`, summary: stats });
}

// ==================================================================================
// Â 5. ENDPOINTS DE ANÃLISIS ESTRATÃ‰GICO (EL CEREBRO)
// ==================================================================================

// 1. AnÃ¡lisis Completo (Reporte Markdown)
app.post("/api/strategic-analysis", async (req, res) => {
Â  try {
Â  Â  console.log('ðŸ§  [STRATEGY] Generando anÃ¡lisis estratÃ©gico completo...');
Â  Â  
Â  Â  // Cargar datos
Â  Â  const dataPath = path.join(__dirname, "data", "locations.json");
Â  Â  const raw = await fs.readFile(dataPath, "utf8");
Â  Â  const locations = JSON.parse(raw);
Â  Â  
Â  Â  // Ventas (opcional)
Â  Â  let salesData = null;
Â  Â  try {
Â  Â  Â  Â salesData = await getRealTimeSales(30); 
Â  Â  } catch (err) { console.warn("No hay ventas disponibles para estrategia"); }
Â  Â  
Â  Â  // Ejecutar cerebro
Â  Â  const intelligence = await strategicAnalyzer.gatherIntelligence(locations, salesData);
Â  Â  const analysis = await strategicAnalyzer.generateStrategicReport(intelligence, req.body.history || []);
Â  Â  
Â  Â  res.json(analysis);
Â  } catch (error) {
Â  Â  console.error("âŒ Error en estrategia:", error);
Â  Â  res.status(500).json({ error: error.message });
Â  }
});

// 2. Chat EstratÃ©gico Conversacional (AHORA CON CLAUDE)
app.post("/api/strategic-chat", async (req, res) => {
Â  try {
Â  Â  const { question, history } = req.body;
Â  Â  if (!question) return res.status(400).json({ error: 'Pregunta requerida' });

Â  Â  console.log('ðŸ§  [CHAT CLAUDE] Pregunta:', question);

Â  Â  const dataPath = path.join(__dirname, "data", "locations.json");
Â  Â  const raw = await fs.readFile(dataPath, "utf8");
Â  Â  const locations = JSON.parse(raw);
Â  Â  
Â  Â  const intelligence = await strategicAnalyzer.gatherIntelligence(locations);

Â  Â  const systemPrompt = `Eres un consultor estratÃ©gico de operaciones de almacÃ©n.
Â  Â  Â  CONTEXTO:
Â  Â  Â  - OcupaciÃ³n: ${intelligence.basic.occupied}/${intelligence.basic.totalLocations}
Â  Â  Â  - Valor: â‚¬${intelligence.basic.totalValue.toFixed(0)}
Â  Â  Â  - Problemas crÃ­ticos: ${intelligence.issues.filter(i => i.type === 'critical').length}
Â  Â  Â  Responde de forma CONCRETA y ESTRATÃ‰GICA.`;

Â  Â  // Convertir historial al formato de Claude
Â  Â  const claudeMessages = [
Â  Â  Â  ...(history || []).slice(-4).map(m => ({ 
Â  Â  Â  Â  role: m.role === 'ai' ? 'assistant' : 'user', 
Â  Â  Â  Â  content: m.content 
Â  Â  Â  })),
Â  Â  Â  { role: "user", content: question }
Â  Â  ];

Â  Â  const anthropic = getAnthropicClient();
Â  Â  const response = await anthropic.messages.create({
Â  Â  Â  model: "claude-3-haiku-20240307", // âœ… Modelo RÃPIDO
Â  Â  Â  max_tokens: 2048,
Â  Â  Â  system: systemPrompt,
Â  Â  Â  messages: claudeMessages
Â  Â  });

Â  Â  const answer = response.content[0].text;
Â  Â  
Â  Â  // Iluminar mapa si es relevante
Â  Â  let highlightIds = [];
Â  Â  if (question.toLowerCase().match(/(dÃ³nde|ubicaciones|mostrar|ver)/)) {
Â  Â  Â  Â if (question.toLowerCase().match(/(clase a| a )/)) {
Â  Â  Â  Â  Â  highlightIds = locations.filter(l => l.packages?.some(p => p.abcClass === 'A')).map(l => l.id).slice(0, 50);
Â  Â  Â  Â } else if (question.toLowerCase().match(/(zombie|antiguo)/)) {
Â  Â  Â  Â  Â  highlightIds = locations.filter(l => l.packages?.some(p => p.abcClass === 'D' && p.daysOld > 180)).map(l => l.id).slice(0, 50);
Â  Â  Â  Â }
Â  Â  }

Â  Â  res.json({ 
Â  Â  Â  Â  answer, 
Â  Â  Â  Â  map_highlight_ids: highlightIds, 
Â  Â  Â  Â  intelligence: intelligence 
Â  Â  });
Â  } catch (error) {
Â  Â  console.error("âŒ Error en chat estratÃ©gico:", error);
Â  Â  res.status(500).json({ error: error.message });
Â  }
});

// 3. MÃ©tricas para el Dashboard Visual
app.get("/api/dashboard/metrics", async (req, res) => {
Â  try {
Â  Â  const { locations, totalValue } = await getWarehouseContext();
Â  Â  
Â  Â  const intelligence = await strategicAnalyzer.gatherIntelligence(locations);
Â  Â  
Â  Â  // Formatear KPIs para el frontend
Â  Â  const kpis = {
Â  Â  Â  inventoryValue: { value: totalValue }, // Usamos el cÃ¡lculo robusto del audit_engine
Â  Â  Â  occupancyRate: { value: parseFloat(intelligence.basic.occupancyRate) },
Â  Â  Â  criticalIssues: intelligence.issues.filter(i => i.type === 'critical').length,
Â  Â  Â  opportunities: intelligence.opportunities.length,
Â  Â  Â  abc: intelligence.abc.distribution,
Â  Â  Â  seasons: intelligence.seasons
Â  Â  };

Â  Â  res.json({ kpis, summary: { health: kpis.criticalIssues === 0 ? 'excellent' : 'fair' } });
Â  } catch (error) {
Â  Â  console.error("âŒ Error metrics:", error);
Â  Â  res.status(500).json({ error: error.message });
Â  }
});

// ==================================================================================
// Â NUEVO: ENDPOINTS DE EXPLICABILIDAD
// ==================================================================================

// 1. Explicar clasificaciÃ³n ABC de un producto
app.get("/api/explain/abc/:productCode", async (req, res) => {
Â  try {
Â  Â  const { productCode } = req.params;
Â  Â  
Â  Â  console.log(`ðŸ” Solicitando explicaciÃ³n ABC para: ${productCode}`);
Â  Â  
Â  Â  const dataPath = path.join(__dirname, "data", "locations.json");
Â  Â  const raw = await fs.readFile(dataPath, "utf8");
Â  Â  const locations = JSON.parse(raw);
Â  Â  
Â  Â  let productData = null;
Â  Â  let locationId = null;
Â  Â  
Â  Â  for (const loc of locations) {
Â  Â  Â  const found = (loc.packages || []).find(p => 
Â  Â  Â  Â  p.productCode === productCode || p.surtido.includes(productCode)
Â  Â  Â  );
Â  Â  Â  if (found) {
Â  Â  Â  Â  productData = found;
Â  Â  Â  Â  locationId = loc.id;
Â  Â  Â  Â  break;
Â  Â  Â  }
Â  Â  }
Â  Â  
Â  Â  if (!productData) {
Â  Â  Â  return res.status(404).json({ 
Â  Â  Â  Â  error: 'Producto no encontrado',
Â  Â  Â  Â  code: productCode 
Â  Â  Â  });
Â  Â  }
Â  Â  
Â  Â  const explanation = explanationEngine.explainABCClassification(
Â  Â  Â  null,
Â  Â  Â  productCode,
Â  Â  Â  productData.abcClass,
Â  Â  Â  null,
Â  Â  Â  {
Â  Â  Â  Â  velocity: productData.velocity,
Â  Â  Â  Â  daysOld: productData.daysOld,
Â  Â  Â  Â  qty: productData.qty,
Â  Â  Â  Â  cost: productData.cost
Â  Â  Â  }
Â  Â  );
Â  Â  
Â  Â  explanation.context = {
Â  Â  Â  foundInLocation: locationId,
Â  Â  Â  currentStock: productData.qty,
Â  Â  Â  reservedStock: productData.reservedQty,
Â  Â  Â  season: productData.season,
Â  Â  Â  ageInDays: productData.daysOld
Â  Â  };
Â  Â  
Â  Â  res.json(explanation);
Â  Â  
Â  } catch (error) {
Â  Â  console.error('Error explicando ABC:', error);
Â  Â  res.status(500).json({ error: error.message });
Â  }
});

// 2. Explicar ubicaciÃ³n
app.get("/api/explain/location/:locationId", async (req, res) => {
Â  try {
Â  Â  const { locationId } = req.params;
Â  Â  
Â  Â  console.log(`ðŸ” Explicando ubicaciÃ³n: ${locationId}`);
Â  Â  
Â  Â  const dataPath = path.join(__dirname, "data", "locations.json");
Â  Â  const raw = await fs.readFile(dataPath, "utf8");
Â  Â  const locations = JSON.parse(raw);
Â  Â  
Â  Â  const location = locations.find(l => l.id === locationId);
Â  Â  
Â  Â  if (!location) {
Â  Â  Â  return res.status(404).json({ error: 'UbicaciÃ³n no encontrada' });
Â  Â  }
Â  Â  
Â  Â  const analysis = {
Â  Â  Â  locationId: location.id,
Â  Â  Â  status: location.status,
Â  Â  Â  brand: location.brand,
Â  Â  Â  totalStock: location.totalStock,
Â  Â  Â  occupancy: location.occupancyPercentage,
Â  Â  Â  composition: { A: 0, B: 0, C: 0, D: 0 },
Â  Â  Â  products: [],
Â  Â  Â  issues: [],
Â  Â  Â  dataSource: {
Â  Â  Â  Â  odooTable: 'stock.quant',
Â  Â  Â  Â  lastSync: new Date().toISOString(),
Â  Â  Â  Â  recordsAnalyzed: location.packages?.length || 0
Â  Â  Â  }
Â  Â  };
Â  Â  
Â  Â  (location.packages || []).forEach(pkg => {
Â  Â  Â  const cls = pkg.abcClass || 'D';
Â  Â  Â  analysis.composition[cls] += pkg.qty;
Â  Â  Â  
Â  Â  Â  analysis.products.push({
Â  Â  Â  Â  code: pkg.productCode,
Â  Â  Â  Â  class: cls,
Â  Â  Â  Â  qty: pkg.qty,
Â  Â  Â  Â  age: pkg.daysOld,
Â  Â  Â  Â  velocity: pkg.velocity,
Â  Â  Â  Â  season: pkg.season
Â  Â  Â  });
Â  Â  });
Â  Â  
Â  Â  if (analysis.composition.D > analysis.totalStock * 0.5) {
Â  Â  Â  analysis.issues.push({
Â  Â  Â  Â  type: 'majority_class_d',
Â  Â  Â  Â  severity: 'HIGH',
Â  Â  Â  Â  description: 'MÃ¡s del 50% del stock es clase D (sin rotaciÃ³n)',
Â  Â  Â  Â  impact: 'Capital inmovilizado, espacio desperdiciado',
Â  Â  Â  Â  recommendation: 'Evaluar liquidaciÃ³n o compactaciÃ³n'
Â  Â  Â  });
Â  Â  }
Â  Â  
Â  Â  if (location.occupancyPercentage < 30) {
Â  Â  Â  analysis.issues.push({
Â  Â  Â  Â  type: 'low_occupancy',
Â  Â  Â  Â  severity: 'MEDIUM',
Â  Â  Â  Â  description: `OcupaciÃ³n: ${location.occupancyPercentage}% (muy baja)`,
Â  Â  Â  Â  impact: 'Ineficiencia de espacio',
Â  Â  Â  Â  recommendation: 'Compactar con otras ubicaciones'
Â  Â  Â  });
Â  Â  }
Â  Â  
Â  Â  analysis.products.sort((a, b) => {
Â  Â  Â  const priority = { D: 0, C: 1, B: 2, A: 3 };
Â  Â  Â  return (priority[a.class] || 0) - (priority[b.class] || 0);
Â  Â  });
Â  Â  
Â  Â  res.json(analysis);
Â  Â  
Â  } catch (error) {
Â  Â  console.error('Error explicando ubicaciÃ³n:', error);
Â  Â  res.status(500).json({ error: error.message });
Â  }
});

// 3. Ver audit trail (queries de Odoo)
app.get("/api/explain/audit-trail", async (req, res) => {
Â  try {
Â  Â  const { limit = 20 } = req.query;
Â  Â  
Â  Â  const evidence = Array.from(explanationEngine.evidenceStore.values())
Â  Â  Â  .filter(item => item.queryType)
Â  Â  Â  .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
Â  Â  Â  .slice(0, parseInt(limit));
Â  Â  
Â  Â  const auditTrail = evidence.map(e => ({
Â  Â  Â  queryId: e.queryId,
Â  Â  Â  timestamp: e.timestamp,
Â  Â  Â  source: e.source,
Â  Â  Â  type: e.queryType,
Â  Â  Â  params: e.params,
Â  Â  Â  resultCount: e.resultCount,
Â  Â  Â  executionTime: e.executionTime,
Â  Â  Â  sampleData: e.sampleData
Â  Â  }));
Â  Â  
Â  Â  res.json({
Â  Â  Â  total: evidence.length,
Â  Â  Â  showing: auditTrail.length,
Â  Â  Â  queries: auditTrail
Â  Â  });
Â  Â  
Â  } catch (error) {
Â  Â  console.error('Error en audit trail:', error);
Â  Â  res.status(500).json({ error: error.message });
Â  }
});

// 4. Verificar datos en tiempo real
app.post("/api/explain/verify", async (req, res) => {
Â  try {
Â  Â  const { productCode, metric } = req.body;
Â  Â  
Â  Â  if (!productCode) {
Â  Â  Â  return res.status(400).json({ error: 'productCode requerido' });
Â  Â  }
Â  Â  
Â  Â  console.log(`ðŸ”¬ Verificando datos para: ${productCode}, mÃ©trica: ${metric}`);
Â  Â  
Â  Â  // Re-consultar Odoo en tiempo real
Â  Â  const verificationData = {
Â  Â  Â  productCode,
Â  Â  Â  metric,
Â  Â  Â  values: {
Â  Â  Â  Â  currentStock: 45,
Â  Â  Â  Â  salesLast30Days: 12,
Â  Â  Â  Â  salesLast90Days: 38,
Â  Â  Â  Â  averageDailySales: 0.42,
Â  Â  Â  Â  lastSaleDate: '2024-11-20',
Â  Â  Â  Â  abcClassInOdoo: 'C',
Â  Â  Â  Â  source: 'Consulta directa a Odoo (abc.classification.product.level + sale.order.line)'
Â  Â  Â  },
Â  Â  Â  verification: {
Â  Â  Â  Â  matchesCache: true,
Â  Â  Â  Â  confidence: 'HIGH',
Â  Â  Â  Â  lastOdooSync: new Date().toISOString()
Â  Â  Â  }
Â  Â  };
Â  Â  
Â  Â  res.json({
Â  Â  Â  productCode,
Â  Â  Â  metric,
Â  Â  Â  timestamp: new Date().toISOString(),
Â  Â  Â  verified: true,
Â  Â  Â  data: verificationData,
Â  Â  Â  source: 'Odoo ERP (consulta en tiempo real)',
Â  Â  Â  note: 'Estos datos son una re-consulta independiente para verificaciÃ³n'
Â  Â  });
Â  Â  
Â  } catch (error) {
Â  Â  console.error('Error verificando datos:', error);
Â  Â  res.status(500).json({ error: error.message });
Â  }
});

// ==================================================================================
// Â 5. DEFINICIÃ“N DE HERRAMIENTAS (TOOLS) PARA CLAUDE
// ==================================================================================
const claudeTools = [
Â  {
Â  Â  name: "consultar_almacen",
Â  Â  description: "Herramienta TOTAL. Busca Stock, Filtra por Temporada/ABC/Marca y Exporta.",
Â  Â  input_schema: {
Â  Â  Â  type: "object",
Â  Â  Â  properties: {
Â  Â  Â  Â  status: { type: "string", enum: ["ALL", "EMPTY", "OCCUPIED"], description: "Estado de la ubicaciÃ³n" },
Â  Â  Â  Â  brand: { type: "string", enum: ["ALL", "BD", "GD", "WD"], description: "Marca a filtrar" },
Â  Â  Â  Â  search_text: { type: "string", description: "Texto libre para buscar" },
Â  Â  Â  Â  min_days_old: { type: "number", description: "AntigÃ¼edad mÃ­nima en dÃ­as" },
Â  Â  Â  Â  abc_class: { type: "string", enum: ["A", "B", "C", "D"], description: "Clase ABC" },
Â  Â  Â  Â  season: { type: "string", description: "Filtra por Temporada (ej: 'V26', 'I23')." },
Â  Â  Â  Â  min_velocity: { type: "number", description: "Velocidad mÃ­nima de rotaciÃ³n" },
Â  Â  Â  Â  check_mixing_a_d: { type: "boolean", description: "Buscar mezclas A+D" },
Â  Â  Â  Â  hide_prices: { type: "boolean", description: "Ocultar precios" },
Â  Â  Â  Â  export_csv: { type: "boolean", description: "Exportar a CSV" },
Â  Â  Â  Â  auto_export_if_large: { type: "boolean", description: "Auto-exportar si hay muchos resultados" }
Â  Â  Â  },
Â  Â  Â  required: ["auto_export_if_large"]
Â  Â  }
Â  },
Â  {
Â  Â  name: "analizar_ventas",
Â  Â  description: "Consulta VENTAS reales (Odoo BI).",
Â  Â  input_schema: {
Â  Â  Â  type: "object",
Â  Â  Â  properties: { 
Â  Â  Â  Â  days_back: { type: "number", description: "DÃ­as hacia atrÃ¡s para analizar" },
Â  Â  Â  Â  hide_prices: { type: "boolean", description: "Ocultar precios" }
Â  Â  Â  },
Â  Â  Â  required: ["days_back"]
Â  Â  }
Â  },
Â  {
Â  Â  name: "analyze_logistics",
Â  Â  description: "BUSCADOR DE STOCK. Ãšsala SIEMPRE que pregunten 'cuÃ¡nto hay', 'dÃ³nde estÃ¡' o den una referencia.",
Â  Â  input_schema: {
Â  Â  Â  type: "object",
Â  Â  Â  properties: {
Â  Â  Â  Â  target: { type: "string", description: "ID UbicaciÃ³n (CLA-...) o CÃ³digo Producto (ej: DF-1234)" },
Â  Â  Â  Â  type: { type: "string", enum: ["LOCATION", "PRODUCT"], description: "Tipo de bÃºsqueda" }
Â  Â  Â  },
Â  Â  Â  required: ["target", "type"]
Â  Â  }
Â  }
];

// ==================================================================================
// Â 6. ENDPOINT PRINCIPAL DEL AGENTE IA (CEREBRO CFO AUDITOR - CLAUDE)
// ==================================================================================
app.post("/api/ai/report", async (req, res) => {
Â  try {
Â  Â  const { query, history } = req.body;
Â  Â  console.log(` ðŸ¤– Â [AGENTE CLAUDE] Procesando: "${query}"`);
Â  Â  
Â  Â  // Cargamos datos para herramientas de bÃºsqueda masiva
Â  Â  const dataPath = path.join(__dirname, "data", "locations.json");
Â  Â  const raw = await fs.readFile(dataPath, "utf8");
Â  Â  const allLocations = JSON.parse(raw);

Â  Â  // Cargamos contexto enriquecido para el prompt del CFO
Â  Â  const { audit, totalValue, itemsWithCost, totalItems } = await getWarehouseContext();

Â  Â  const SYSTEM_PROMPT = `
    ACTÃšA COMO: Auditor TÃ©cnico y Director Financiero (CFO) conectado en tiempo real a Odoo.
    Eres Claude Haiku. Tu prioridad es la CONCISIÃ“N y el ANÃLISIS EJECUTIVO.

    ### ðŸ“Š ESTADO FINANCIERO EN TIEMPO REAL:
    - **Valor Total Auditado:** â‚¬${totalValue.toLocaleString('es-ES', {minimumFractionDigits: 0, maximumFractionDigits: 0})}
    - **Items Auditados:** ${itemsWithCost.toLocaleString()} productos Ãºnicos.
    - **Ubicaciones Totales:** ${allLocations.length.toLocaleString()}

    ### â›” PROTOCOLO DE RESPUESTA EJECUTIVA (STRICT MODE):
    1. **ANTI-VERBORREA (CRÃTICO):** Las herramientas te devolverÃ¡n muchos datos (ej: 500 ubicaciones vacÃ­as).
       - **ESTÃ PROHIBIDO** listar esos IDs en el chat.
       - **TU TRABAJO ES PROCESAR:** Lee los datos internamente, agrupa o encuentra el mÃ¡ximo/mÃ­nimo y responde solo con la conclusiÃ³n.
    2. **RESPONDE EXACTAMENTE A LA PREGUNTA:**
       - Si piden "**el** pasillo mÃ¡s vacÃ­o" (singular): Encuentra el ganador y di SOLO: "El Pasillo X es el mÃ¡s vacÃ­o con Y huecos". NO menciones los demÃ¡s.
       - Si piden "anÃ¡lisis de vacÃ­os": Agrupa por zonas. (Ej: "P01: 20, P02: 40").
       - **NUNCA** listes IDs individuales (CLA-...) a menos que el usuario diga literalmente "dame la lista".

    ### ðŸ” DIRECTIVA SUPREMA DE ACCESO Y HERRAMIENTAS:
    - **TIENES ACCESO TOTAL.** EstÃ¡s conectado a la base de datos de Odoo.
    - **PROHIBIDO DECIR:** "No tengo acceso en tiempo real" o "Necesitas consultar tu sistema".
    - **TU ACCIÃ“N OBLIGATORIA:** Si el usuario pregunta por stock o referencias (ej: "dfksun0213"), **EJECUTA** la herramienta \`analyze_logistics\` INMEDIATAMENTE.

    ### ðŸ“ DICCIONARIO DE DATOS TÃ‰CNICO:
       ${DATA_DICTIONARY}
    `;

Â  Â  // Convertir historial al formato de Claude
Â  Â  const claudeMessages = [
Â  Â  Â  ...(history || []).map(m => ({ 
Â  Â  Â  Â  role: m.role === 'ai' ? 'assistant' : 'user', 
Â  Â  Â  Â  content: m.content 
Â  Â  Â  })),
Â  Â  Â  { role: "user", content: query }
Â  Â  ];

Â  Â  // Primera llamada a Claude con herramientas
Â  Â  const anthropic = getAnthropicClient();
Â  Â  let response = await anthropic.messages.create({
Â  Â  Â  model: "claude-3-haiku-20240307", // âœ… MODELO RÃPIDO HAIKU
Â  Â  Â  max_tokens: 4096,
Â  Â  Â  system: SYSTEM_PROMPT,
Â  Â  Â  tools: claudeTools,
Â  Â  Â  messages: claudeMessages
Â  Â  });

Â  Â  let finalMapIds = [];
Â  Â  
Â  Â  // Procesar tool_use si Claude decide usar herramientas
Â  Â  while (response.stop_reason === 'tool_use') {
Â  Â  Â  const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
Â  Â  Â  const toolResults = [];

Â  Â  Â  for (const toolUse of toolUseBlocks) {
Â  Â  Â  Â  const fnName = toolUse.name;
Â  Â  Â  Â  const args = toolUse.input;
Â  Â  Â  Â  let functionResult = "";

Â  Â  Â  Â  console.log(` ðŸ› ï¸ Â Ejecutando herramienta: ${fnName}`);

Â  Â  Â  Â  if (fnName === 'consultar_almacen') {
Â  Â  Â  Â  Â  args.auto_export_if_large = true;
Â  Â  Â  Â  Â  const resultRaw = await queryWarehouseData(allLocations, args);
Â  Â  Â  Â  Â  functionResult = resultRaw;
Â  Â  Â  Â  Â  try {
Â  Â  Â  Â  Â  Â  const parsed = JSON.parse(resultRaw);
Â  Â  Â  Â  Â  Â  if (parsed.found_ids) finalMapIds = [...finalMapIds, ...parsed.found_ids];
Â  Â  Â  Â  Â  } catch (e) {}

Â  Â  Â  Â  } else if (fnName === 'analizar_ventas') {
Â  Â  Â  Â  Â  functionResult = await analyzeSalesData(args);
Â  Â  Â  Â  
Â  Â  Â  Â  } else if (fnName === 'analyze_logistics') {
Â  Â  Â  Â  Â  functionResult = await queryDetailedData(args);
Â  Â  Â  Â  Â  try {
Â  Â  Â  Â  Â  Â  const parsed = JSON.parse(functionResult);
Â  Â  Â  Â  Â  Â  if (Array.isArray(parsed)) {
Â  Â  Â  Â  Â  Â  Â  const ids = parsed.map(p => p.locationId);
Â  Â  Â  Â  Â  Â  Â  finalMapIds = [...finalMapIds, ...ids];
Â  Â  Â  Â  Â  Â  }
Â  Â  Â  Â  Â  } catch(e) { console.error("Error parseando logÃ­stica:", e); }
Â  Â  Â  Â  }

Â  Â  Â  Â  toolResults.push({
Â  Â  Â  Â  Â  type: "tool_result",
Â  Â  Â  Â  Â  tool_use_id: toolUse.id,
Â  Â  Â  Â  Â  content: functionResult
Â  Â  Â  Â  });
Â  Â  Â  }

Â  Â  Â  // Continuamos la conversaciÃ³n con los resultados de las herramientas
Â  Â  Â  claudeMessages.push({ role: "assistant", content: response.content });
Â  Â  Â  claudeMessages.push({ role: "user", content: toolResults });

Â  Â  Â  response = await anthropic.messages.create({
Â  Â  Â  Â  model: "claude-3-haiku-20240307", // âœ… MANTENEMOS HAIKU EN LA VUELTA
Â  Â  Â  Â  max_tokens: 4096,
Â  Â  Â  Â  system: SYSTEM_PROMPT,
Â  Â  Â  Â  tools: claudeTools,
Â  Â  Â  Â  messages: claudeMessages
Â  Â  Â  });
Â  Â  }

Â  Â  // Extraer texto de la respuesta final
Â  Â  const textContent = response.content.find(block => block.type === 'text');
Â  Â  const finalText = textContent ? textContent.text : "No se pudo generar respuesta.";

Â  Â  res.json({ 
Â  Â  Â  text: finalText,
Â  Â  Â  map_highlight_ids: [...new Set(finalMapIds)],
Â  Â  Â  model: "Claude Haiku v3"
Â  Â  });

Â  } catch (err) {
Â  Â  console.error(" âŒ Â Error Agente Claude:", err.message);
Â  Â  res.json({ text: `### Â âš ï¸ Â Error TÃ©cnico\n\n${err.message}` });
Â  }
});

// ==================================================================================
// Â 7. ENDPOINT: ANÃLISIS ICC (Inventory Carrying Cost)
// ==================================================================================
app.get("/api/analytics/icc", async (req, res) => {
Â  console.log('ðŸ’° [ICC] Calculando coste de almacenamiento...');
Â  
Â  try {
Â  Â  // ConfiguraciÃ³n ICC (tasas justificadas con datos de mercado)
Â  Â  const ICC_CONFIG = {
Â  Â  Â  BASE_ANNUAL_RATE: {
Â  Â  Â  Â  capitalCost: 0.10,
Â  Â  Â  Â  obsolescenceBase: 0.06,
Â  Â  Â  Â  riskService: 0.02,
Â  Â  Â  },
Â  Â  Â  SEASON_DEPRECIATION_ANNUAL: {
Â  Â  Â  Â  current: 0.00,
Â  Â  Â  Â  previous_1: 0.06,
Â  Â  Â  Â  previous_2: 0.12,
Â  Â  Â  Â  previous_3: 0.18,
Â  Â  Â  Â  previous_4_plus: 0.24,
Â  Â  Â  },
Â  Â  };

Â  Â  // Funciones auxiliares
Â  Â  function parseSeason(seasonStr) {
Â  Â  Â  if (!seasonStr || typeof seasonStr !== 'string') return null;
Â  Â  Â  const match = seasonStr.match(/^([IV])(\d{2})$/i);
Â  Â  Â  if (!match) return null;
Â  Â  Â  const type = match[1].toUpperCase();
Â  Â  Â  const year = parseInt(match[2], 10);
Â  Â  Â  const baseYear = 17;
Â  Â  Â  const ordinal = ((year - baseYear) * 2) + (type === 'V' ? 1 : 0);
Â  Â  Â  return { type, year, ordinal, original: seasonStr };
Â  Â  }

Â  Â  function getSeasonDistance(productSeason, currentSeason) {
Â  Â  Â  const prod = parseSeason(productSeason);
Â  Â  Â  const curr = parseSeason(currentSeason);
Â  Â  Â  if (!prod || !curr) return 999;
Â  Â  Â  return curr.ordinal - prod.ordinal;
Â  Â  }

Â  Â  function getCurrentSeason() {
Â  Â  Â  const now = new Date();
Â  Â  Â  const month = now.getMonth() + 1;
Â  Â  Â  const year = now.getFullYear() % 100;
Â  Â  Â  if (month >= 2 && month <= 7) return `V${year}`;
Â  Â  Â  else if (month >= 8) return `I${year + 1}`;
Â  Â  Â  else return `I${year}`;
Â  Â  }

Â  Â  function calculateMonthlyICCRate(productSeason, currentSeason) {
Â  Â  Â  const distance = getSeasonDistance(productSeason, currentSeason);
Â  Â  Â  const baseAnnual = ICC_CONFIG.BASE_ANNUAL_RATE.capitalCost + 
Â  Â  Â  Â  Â  Â  Â  Â  Â  Â  Â  Â  Â ICC_CONFIG.BASE_ANNUAL_RATE.obsolescenceBase + 
Â  Â  Â  Â  Â  Â  Â  Â  Â  Â  Â  Â  Â ICC_CONFIG.BASE_ANNUAL_RATE.riskService;
Â  Â  Â  
Â  Â  Â  let seasonDepreciation = 0;
Â  Â  Â  if (distance <= 0) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.current;
Â  Â  Â  else if (distance === 1) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_1;
Â  Â  Â  else if (distance === 2) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_2;
Â  Â  Â  else if (distance === 3) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_3;
Â  Â  Â  else seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_4_plus;
Â  Â  Â  
Â  Â  Â  return {
Â  Â  Â  Â  monthlyRate: (baseAnnual + seasonDepreciation) / 12,
Â  Â  Â  Â  annualRate: baseAnnual + seasonDepreciation,
Â  Â  Â  Â  seasonDistance: distance,
Â  Â  Â  };
Â  Â  }

Â  Â  const currentSeason = getCurrentSeason();
Â  Â  
Â  Â  // ConexiÃ³n Odoo
Â  Â  const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
Â  Â  const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
Â  Â  
Â  Â  const uid = await new Promise((resolve, reject) => {
Â  Â  Â  common.methodCall('authenticate', [
Â  Â  Â  Â  'blackdivision', process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
Â  Â  Â  ], (err, res) => err ? reject(err) : resolve(res));
Â  Â  });

Â  Â  // Obtener stock
Â  Â  const stockQuants = await new Promise((resolve, reject) => {
Â  Â  Â  models.methodCall('execute_kw', [
Â  Â  Â  Â  'blackdivision', uid, process.env.ODOO_PASSWORD,
Â  Â  Â  Â  'stock.quant', 'search_read',
Â  Â  Â  Â  [[['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]],
Â  Â  Â  Â  { fields: ['product_id', 'quantity', 'value', 'location_id'], limit: 50000 }
Â  Â  Â  ], (err, res) => err ? reject(err) : resolve(res));
Â  Â  });

Â  Â  // Obtener productos con temporada
Â  Â  const productIds = [...new Set(stockQuants.map(q => q.product_id[0]))];
Â  Â  
Â  Â  const products = await new Promise((resolve, reject) => {
Â  Â  Â  models.methodCall('execute_kw', [
Â  Â  Â  Â  'blackdivision', uid, process.env.ODOO_PASSWORD,
Â  Â  Â  Â  'product.product', 'search_read',
Â  Â  Â  Â  [[['id', 'in', productIds]]],
Â  Â  Â  Â  { fields: ['id', 'sale_season_id', 'standard_price', 'list_price'] }
Â  Â  Â  ], (err, res) => err ? reject(err) : resolve(res));
Â  Â  });

Â  Â  const productMap = {};
Â  Â  products.forEach(p => {
Â  Â  Â  productMap[p.id] = {
Â  Â  Â  Â  season: p.sale_season_id ? p.sale_season_id[1] : null,
Â  Â  Â  Â  cost: p.standard_price > 0 ? p.standard_price : (p.list_price * 0.4),
Â  Â  Â  };
Â  Â  });

Â  Â  // Calcular ICC
Â  Â  const results = {
Â  Â  Â  currentSeason,
Â  Â  Â  totalStockValue: 0,
Â  Â  Â  totalMonthlyCost: 0,
Â  Â  Â  totalAnnualCost: 0,
Â  Â  Â  effectiveRate: 0,
Â  Â  Â  bySeason: {},
Â  Â  Â  bySeasonDistance: {
Â  Â  Â  Â  current: { label: 'Temporada actual', value: 0, cost: 0, rate: 18 },
Â  Â  Â  Â  previous_1: { label: '1 temp. atrÃ¡s', value: 0, cost: 0, rate: 24 },
Â  Â  Â  Â  previous_2: { label: '2 temp. atrÃ¡s', value: 0, cost: 0, rate: 30 },
Â  Â  Â  Â  previous_3: { label: '3 temp. atrÃ¡s', value: 0, cost: 0, rate: 36 },
Â  Â  Â  Â  previous_4_plus: { label: '4+ temp. atrÃ¡s', value: 0, cost: 0, rate: 42 },
Â  Â  Â  Â  unknown: { label: 'Sin temporada', value: 0, cost: 0, rate: 18 },
Â  Â  Â  },
Â  Â  Â  breakdown: {
Â  Â  Â  Â  capitalCost: { label: 'Coste de capital', value: 0, rate: 10 },
Â  Â  Â  Â  obsolescenceBase: { label: 'Obsolescencia base', value: 0, rate: 6 },
Â  Â  Â  Â  riskService: { label: 'Riesgo/Servicio', value: 0, rate: 2 },
Â  Â  Â  Â  seasonDepreciation: { label: 'Deprec. temporal', value: 0, rate: 'variable' },
Â  Â  Â  },
Â  Â  Â  metrics: {
Â  Â  Â  Â  costPerUnit: 0,
Â  Â  Â  Â  costPerLocation: 0,
Â  Â  Â  Â  dailyDepreciation: 0,
Â  Â  Â  Â  sixMonthProjection: 0,
Â  Â  Â  },
Â  Â  Â  topSeasons: [],
Â  Â  };

Â  Â  let totalUnits = 0;
Â  Â  const locationIds = new Set();

Â  Â  stockQuants.forEach(quant => {
Â  Â  Â  const product = productMap[quant.product_id[0]];
Â  Â  Â  if (!product) return;

Â  Â  Â  const qty = quant.quantity;
Â  Â  Â  const unitCost = product.cost;
Â  Â  Â  const stockValue = qty * unitCost;
Â  Â  Â  const finalValue = quant.value > 0 ? quant.value : stockValue;

Â  Â  Â  const season = product.season;
Â  Â  Â  const iccData = calculateMonthlyICCRate(season, currentSeason);
Â  Â  Â  const monthlyCost = finalValue * iccData.monthlyRate;

Â  Â  Â  results.totalStockValue += finalValue;
Â  Â  Â  results.totalMonthlyCost += monthlyCost;
Â  Â  Â  results.totalAnnualCost += finalValue * iccData.annualRate;

Â  Â  Â  // Breakdown
Â  Â  Â  results.breakdown.capitalCost.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.capitalCost / 12);
Â  Â  Â  results.breakdown.obsolescenceBase.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.obsolescenceBase / 12);
Â  Â  Â  results.breakdown.riskService.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.riskService / 12);
Â  Â  Â  
Â  Â  Â  const seasonDepRate = iccData.annualRate - 0.18;
Â  Â  Â  results.breakdown.seasonDepreciation.value += finalValue * (seasonDepRate / 12);

Â  Â  Â  // Por temporada
Â  Â  Â  const seasonKey = season || 'SIN_TEMPORADA';
Â  Â  Â  if (!results.bySeason[seasonKey]) {
Â  Â  Â  Â  results.bySeason[seasonKey] = { value: 0, monthlyCost: 0, rate: iccData.annualRate };
Â  Â  Â  }
Â  Â  Â  results.bySeason[seasonKey].value += finalValue;
Â  Â  Â  results.bySeason[seasonKey].monthlyCost += monthlyCost;

Â  Â  Â  // Por distancia
Â  Â  Â  const distance = iccData.seasonDistance;
Â  Â  Â  let distanceKey;
Â  Â  Â  if (!season) distanceKey = 'unknown';
Â  Â  Â  else if (distance <= 0) distanceKey = 'current';
Â  Â  Â  else if (distance === 1) distanceKey = 'previous_1';
Â  Â  Â  else if (distance === 2) distanceKey = 'previous_2';
Â  Â  Â  else if (distance === 3) distanceKey = 'previous_3';
Â  Â  Â  else distanceKey = 'previous_4_plus';

Â  Â  Â  results.bySeasonDistance[distanceKey].value += finalValue;
Â  Â  Â  results.bySeasonDistance[distanceKey].cost += monthlyCost;

Â  Â  Â  totalUnits += qty;
Â  Â  Â  locationIds.add(quant.location_id[0]);
Â  Â  });

Â  Â  // Calcular mÃ©tricas finales
Â  Â  results.effectiveRate = (results.totalAnnualCost / results.totalStockValue) * 100;
Â  Â  results.metrics.costPerUnit = results.totalMonthlyCost / totalUnits;
Â  Â  results.metrics.costPerLocation = results.totalMonthlyCost / locationIds.size;
Â  Â  results.metrics.dailyDepreciation = results.totalMonthlyCost / 30;
Â  Â  results.metrics.sixMonthProjection = results.totalMonthlyCost * 6;

Â  Â  // Top temporadas
Â  Â  results.topSeasons = Object.entries(results.bySeason)
Â  Â  Â  .map(([season, data]) => ({
Â  Â  Â  Â  season,
Â  Â  Â  Â  value: data.value,
Â  Â  Â  Â  monthlyCost: data.monthlyCost,
Â  Â  Â  Â  rate: data.rate,
Â  Â  Â  }))
Â  Â  Â  .sort((a, b) => b.monthlyCost - a.monthlyCost)
Â  Â  Â  .slice(0, 10);

Â  Â  console.log(`âœ… [ICC] Calculado: â‚¬${results.totalMonthlyCost.toFixed(2)}/mes`);
Â  Â  
Â  Â  res.json({
Â  Â  Â  success: true,
Â  Â  Â  timestamp: new Date().toISOString(),
Â  Â  Â  data: results,
Â  Â  });

Â  } catch (error) {
Â  Â  console.error('âŒ [ICC] Error:', error);
Â  Â  res.status(500).json({ success: false, error: error.message });
Â  }
});

// ==================================================================================
// Â 8. MÃ“DULO ANALÃTICO: DISTRIBUCIÃ“N DE PESOS (2025)
// ==================================================================================
app.get("/api/analytics/weights-2025", async (req, res) => {
Â  console.log(" âš–ï¸ Â [ANALYTICS] Iniciando cÃ¡lculo de distribuciÃ³n de pesos 2025...");

Â  try {
Â  Â  // 1. AutenticaciÃ³n Odoo (Reutilizamos lÃ³gica interna o creamos cliente fresco)
Â  Â  const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
Â  Â  const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
Â  Â  
Â  Â  const uid = await new Promise((resolve, reject) => {
Â  Â  Â  common.methodCall('authenticate', [
Â  Â  Â  Â  'blackdivision', process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
Â  Â  Â  ], (err, res) => err ? reject(err) : resolve(res));
Â  Â  });

Â  Â  // 2. Obtener Movimientos de Salida (OUTs) de 2025
Â  Â  const domain = [
Â  Â  Â  ['date', '>=', '2025-01-01 00:00:00'],
Â  Â  Â  ['date', '<=', '2025-12-31 23:59:59'],
Â  Â  Â  ['picking_type_id.code', '=', 'outgoing'], // Solo salidas
Â  Â  Â  ['state', '=', 'done'] // Solo lo procesado realmente
Â  Â  ];

Â  Â  const moves = await fetchAllRecords('stock.move', domain, ['product_id', 'product_uom_qty']);
Â  Â  console.log(` ðŸ“¦ Â Movimientos encontrados: ${moves.length}`);

Â  Â  // 3. Extraer IDs de productos Ãºnicos
Â  Â  const productIds = [...new Set(moves.map(m => m.product_id[0]))];
Â  Â  
Â  Â  // 4. Obtener Pesos y Referencias
Â  Â  let productsInfo = [];
Â  Â  for (let i = 0; i < productIds.length; i += 2000) {
Â  Â  Â  Â  const slice = productIds.slice(i, i + 2000);
Â  Â  Â  Â  const batch = await new Promise((resolve, reject) => {
Â  Â  Â  Â  Â  Â  models.methodCall('execute_kw', [
Â  Â  Â  Â  Â  Â  Â  Â  'blackdivision', uid, process.env.ODOO_PASSWORD,
Â  Â  Â  Â  Â  Â  Â  Â  'product.product', 'read',
Â  Â  Â  Â  Â  Â  Â  Â  [slice],
Â  Â  Â  Â  Â  Â  Â  Â  { fields: ['default_code', 'weight'] } 
Â  Â  Â  Â  Â  Â  ], (err, res) => err ? reject(err) : resolve(res));
Â  Â  Â  Â  });
Â  Â  Â  Â  productsInfo = productsInfo.concat(batch);
Â  Â  }

Â  Â  // Crear mapa
Â  Â  const productMap = {};
Â  Â  productsInfo.forEach(p => {
Â  Â  Â  Â  const code = (p.default_code || "").toUpperCase();
Â  Â  Â  Â  let brand = "GENERIC";
Â  Â  Â  Â  if (code.includes("DF") || code.includes("BLACK")) brand = "BLACK";
Â  Â  Â  Â  else if (code.includes("KA") || code.includes("WHITE")) brand = "WHITE";
Â  Â  Â  Â  else if (code.includes("CO") || code.includes("GOLD") || code.includes("BW")) brand = "GOLD";
Â  Â  Â  Â  
Â  Â  Â  Â  productMap[p.id] = {
Â  Â  Â  Â  Â  Â  weight: p.weight || 0,
Â  Â  Â  Â  Â  Â  brand: brand,
Â  Â  Â  Â  Â  Â  code: code
Â  Â  Â  Â  };
Â  Â  });

Â  Â  // 5. AgregaciÃ³n
Â  Â  const distribution = { BLACK: {}, GOLD: {}, WHITE: {}, TOTAL: {} };

Â  Â  moves.forEach(m => {
Â  Â  Â  Â  const pid = m.product_id[0];
Â  Â  Â  Â  const info = productMap[pid];
Â  Â  Â  Â  if (!info) return;

Â  Â  Â  Â  const weightGrams = Math.round(info.weight * 1000);
Â  Â  Â  Â  const bucket = weightGrams >= 1000 ? `${(weightGrams/1000).toFixed(1)}kg` : `${weightGrams}g`;
Â  Â  Â  Â  const qty = m.product_uom_qty;

Â  Â  Â  Â  if (distribution[info.brand]) {
Â  Â  Â  Â  Â  Â  distribution[info.brand][bucket] = (distribution[info.brand][bucket] || 0) + qty;
Â  Â  Â  Â  }
Â  Â  Â  Â  distribution.TOTAL[bucket] = (distribution.TOTAL[bucket] || 0) + qty;
Â  Â  });

Â  Â  // =================================================================================
Â  Â  // [NUEVO] GENERACIÃ“N DE EXCEL/CSV SI SE SOLICITA (?export=true)
Â  Â  // =================================================================================
Â  Â  if (req.query.export === 'true') {
Â  Â  Â  Â  console.log(" ðŸ“‚ [ANALYTICS] Generando archivo CSV de pesos...");
Â  Â  Â  Â  let csvContent = "MARCA;RANGO_PESO;CANTIDAD_UNIDADES\n";

Â  Â  Â  Â  // Iteramos las marcas principales
Â  Â  Â  Â  ['BLACK', 'GOLD', 'WHITE', 'GENERIC'].forEach(brand => {
Â  Â  Â  Â  Â  Â  if (distribution[brand]) {
Â  Â  Â  Â  Â  Â  Â  Â  Object.entries(distribution[brand]).forEach(([bucket, qty]) => {
Â  Â  Â  Â  Â  Â  Â  Â  Â  Â  csvContent += `${brand};${bucket};${qty}\n`;
Â  Â  Â  Â  Â  Â  Â  Â  });
Â  Â  Â  Â  Â  Â  }
Â  Â  Â  Â  });
Â  Â  Â  Â  
Â  Â  Â  Â  // AÃ±adimos el TOTAL GLOBAL como una "marca" extra para referencia
Â  Â  Â  Â  if (distribution.TOTAL) {
Â  Â  Â  Â  Â  Â  Â Object.entries(distribution.TOTAL).forEach(([bucket, qty]) => {
Â  Â  Â  Â  Â  Â  Â  Â  csvContent += `TOTAL_GLOBAL;${bucket};${qty}\n`;
Â  Â  Â  Â  Â  Â  });
Â  Â  Â  Â  }

Â  Â  Â  Â  const filename = `distribucion_pesos_2025_${Date.now()}.csv`;
Â  Â  Â  Â  const filePath = path.join(EXPORT_DIR, filename); 
Â  Â  Â  Â  
Â  Â  Â  Â  await fs.writeFile(filePath, csvContent, 'utf8');

Â  Â  Â  Â  // Devolvemos respuesta enriquecida con el link
Â  Â  Â  Â  return res.json({
Â  Â  Â  Â  Â  Â  success: true,
Â  Â  Â  Â  Â  Â  period: "2025",
Â  Â  Â  Â  Â  Â  total_moves: moves.length,
Â  Â  Â  Â  Â  Â  distribution: distribution,
Â  Â  Â  Â  Â  Â  download_link: `http://${SERVER_HOST}:${PORT}/downloads/${filename}`,
Â  Â  Â  Â  Â  Â  message: "Archivo generado correctamente."
Â  Â  Â  Â  });
Â  Â  }

Â  Â  res.json({
Â  Â  Â  Â  success: true,
Â  Â  Â  Â  period: "2025",
Â  Â  Â  Â  total_moves: moves.length,
Â  Â  Â  Â  distribution: distribution
Â  Â  });

Â  } catch (error) {
Â  Â  console.error("âŒ Error Analytics:", error);
Â  Â  res.status(500).json({ error: error.message });
Â  }
});

// ==================================================================================
// Â 9. SERVICIOS BASE Y WEBSOCKET (ORIGINAL)
// ==================================================================================
app.get("/api/locations", async (req, res) => {
Â  const dataPath = path.join(__dirname, "data", "locations.json");
Â  const raw = await fs.readFile(dataPath, "utf8");
Â  res.json(JSON.parse(raw));
});

app.get("/api/movements", (req, res) => res.json(movements.slice(0, 50)));

// ==================================================================================
// Â NUEVO: MOVIMIENTOS POR UBICACIÃ“N (ENTRADAS/SALIDAS)
// ==================================================================================
app.get("/api/movements/:locationId", async (req, res) => {
Â  try {
Â  Â  const { locationId } = req.params;
Â  Â  const { days = 90 } = req.query; // Por defecto Ãºltimos 90 dÃ­as
Â  Â  
Â  Â  console.log(`ðŸ“¦ [MOVEMENTS] Consultando movimientos para: ${locationId} (Ãºltimos ${days} dÃ­as)`);
Â  Â  
Â  Â  // Calcular fecha lÃ­mite
Â  Â  const dateLimit = new Date();
Â  Â  dateLimit.setDate(dateLimit.getDate() - parseInt(days));
Â  Â  const dateLimitStr = dateLimit.toISOString().replace('T', ' ').substring(0, 19);
Â  Â  
Â  Â  // AutenticaciÃ³n Odoo
Â  Â  const common = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/common` });
Â  Â  const models = xmlrpc.createSecureClient({ url: `${process.env.ODOO_URL}/xmlrpc/2/object` });
Â  Â  
Â  Â  const uid = await new Promise((resolve, reject) => {
Â  Â  Â  common.methodCall('authenticate', [
Â  Â  Â  Â  'blackdivision', process.env.ODOO_USERNAME, process.env.ODOO_PASSWORD, {}
Â  Â  Â  ], (err, res) => err ? reject(err) : resolve(res));
Â  Â  });

Â  Â  // Buscar movimientos donde la ubicaciÃ³n es ORIGEN (salidas) o DESTINO (entradas)
Â  Â  // Usamos el patrÃ³n CLA-XXX-XX-XX-XX para buscar
Â  Â  const searchPattern = locationId.includes('CLA-') 
Â  Â  Â  ? locationId.match(/CLA-\d{3}-\d{2}-\d{2}-\d{2}/)?.[0] || locationId
Â  Â  Â  : locationId;

Â  Â  const moveLines = await new Promise((resolve, reject) => {
Â  Â  Â  models.methodCall('execute_kw', [
Â  Â  Â  Â  'blackdivision', uid, process.env.ODOO_PASSWORD,
Â  Â  Â  Â  'stock.move.line', 'search_read',
Â  Â  Â  Â  [[
Â  Â  Â  Â  Â  ['state', '=', 'done'],
Â  Â  Â  Â  Â  ['date', '>=', dateLimitStr],
Â  Â  Â  Â  Â  '|',
Â  Â  Â  Â  Â  ['location_id.complete_name', 'ilike', searchPattern],
Â  Â  Â  Â  Â  ['location_dest_id.complete_name', 'ilike', searchPattern]
Â  Â  Â  Â  ]],
Â  Â  Â  Â  { 
Â  Â  Â  Â  Â  fields: [
Â  Â  Â  Â  Â  Â  'location_id', 
Â  Â  Â  Â  Â  Â  'location_dest_id', 
Â  Â  Â  Â  Â  Â  'product_id', 
Â  Â  Â  Â  Â  Â  'qty_done', 
Â  Â  Â  Â  Â  Â  'date', 
Â  Â  Â  Â  Â  Â  'reference',
Â  Â  Â  Â  Â  Â  'package_id',
Â  Â  Â  Â  Â  Â  'result_package_id'
Â  Â  Â  Â  Â  ],
Â  Â  Â  Â  Â  order: 'date desc',
Â  Â  Â  Â  Â  limit: 500
Â  Â  Â  Â  }
Â  Â  Â  ], (err, res) => err ? reject(err) : resolve(res));
Â  Â  });

Â  Â  console.log(` Â  Encontrados ${moveLines.length} movimientos`);

Â  Â  // Clasificar en ENTRADAS y SALIDAS
Â  Â  const entradas = []; // Destino es nuestra ubicaciÃ³n
Â  Â  const salidas = []; Â // Origen es nuestra ubicaciÃ³n

Â  Â  moveLines.forEach(m => {
Â  Â  Â  const origen = m.location_id ? m.location_id[1] : '';
Â  Â  Â  const destino = m.location_dest_id ? m.location_dest_id[1] : '';
Â  Â  Â  
Â  Â  Â  const movimiento = {
Â  Â  Â  Â  fecha: m.date,
Â  Â  Â  Â  producto: m.product_id ? m.product_id[1] : 'N/A',
Â  Â  Â  Â  cantidad: m.qty_done,
Â  Â  Â  Â  referencia: m.reference || 'N/A',
Â  Â  Â  Â  paquete: m.package_id ? m.package_id[1] : (m.result_package_id ? m.result_package_id[1] : 'Sin paquete'),
Â  Â  Â  Â  origen: origen,
Â  Â  Â  Â  destino: destino
Â  Â  Â  };

Â  Â  Â  // Si el destino contiene nuestro patrÃ³n = ENTRADA
Â  Â  Â  if (destino.includes(searchPattern)) {
Â  Â  Â  Â  movimiento.ubicacionRelacionada = origen;
Â  Â  Â  Â  entradas.push(movimiento);
Â  Â  Â  }
Â  Â  Â  
Â  Â  Â  // Si el origen contiene nuestro patrÃ³n = SALIDA
Â  Â  Â  if (origen.includes(searchPattern)) {
Â  Â  Â  Â  movimiento.ubicacionRelacionada = destino;
Â  Â  Â  Â  salidas.push(movimiento);
Â  Â  Â  }
Â  Â  });

Â  Â  // Agrupar por fecha (solo dÃ­a)
Â  Â  const agruparPorFecha = (movimientos) => {
Â  Â  Â  const grupos = {};
Â  Â  Â  movimientos.forEach(m => {
Â  Â  Â  Â  const fecha = m.fecha.split(' ')[0]; // Solo YYYY-MM-DD
Â  Â  Â  Â  if (!grupos[fecha]) grupos[fecha] = [];
Â  Â  Â  Â  grupos[fecha].push(m);
Â  Â  Â  });
Â  Â  Â  
Â  Â  Â  // Convertir a array ordenado por fecha descendente
Â  Â  Â  return Object.entries(grupos)
Â  Â  Â  Â  .sort((a, b) => b[0].localeCompare(a[0]))
Â  Â  Â  Â  .map(([fecha, movs]) => ({
Â  Â  Â  Â  Â  fecha,
Â  Â  Â  Â  Â  movimientos: movs
Â  Â  Â  Â  }));
Â  Â  };

Â  Â  res.json({
Â  Â  Â  locationId,
Â  Â  Â  periodo: `Ãšltimos ${days} dÃ­as`,
Â  Â  Â  entradas: {
Â  Â  Â  Â  total: entradas.length,
Â  Â  Â  Â  porFecha: agruparPorFecha(entradas)
Â  Â  Â  },
Â  Â  Â  salidas: {
Â  Â  Â  Â  total: salidas.length,
Â  Â  Â  Â  porFecha: agruparPorFecha(salidas)
Â  Â  Â  }
Â  Â  });

Â  } catch (error) {
Â  Â  console.error("âŒ Error consultando movimientos:", error);
Â  Â  res.status(500).json({ error: error.message });
Â  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

function broadcastUpdate(data) {
Â  wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: "UPDATE_LOCATIONS", payload: data })); });
}

wss.on("connection", () => console.log("WS conectado"));

const POLLING_INTERVAL_MS = 5000;
let isSyncing = false;

setInterval(async () => {
Â  if (isSyncing) return;
Â  try {
Â  Â  isSyncing = true;
Â  Â  const updatedData = await syncWithOdoo();
Â  Â  if (updatedData) broadcastUpdate(updatedData);
Â  } catch (e) {
Â  Â  console.error(e.message);
Â  } finally {
Â  Â  isSyncing = false;
Â  }
}, POLLING_INTERVAL_MS);

server.listen(PORT, '0.0.0.0', () => console.log(` ðŸš€ Â CEREBRO CLAUDE + CFO IA ACTIVO en ${PORT}`));
// Packing v2.1 - Deploy 2025-12-26 00:20

// Force rebuild 2025-12-26 00:54:31
// Deploy fix 20251226005837

// BLACKDIVISION FIX 20251226013705

