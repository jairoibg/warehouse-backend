import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { syncWithOdoo, getRealTimeSales } from "./sync_odoo.js";
import OpenAI from "openai";
import multer from "multer";
import xmlrpc from "xmlrpc";
import crypto from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import { packingIntelligence } from "./packing_intelligence.js";

const execPromise = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================================================================================
//  CONFIGURACIÓN GENERAL
// ==================================================================================
const PORT = 4000;
console.log('🔧 [ENV] ODOO_URL:', process.env.ODOO_URL);
console.log('🔧 [ENV] ODOO_DB:', process.env.ODOO_DB);
const SERVER_HOST = "localhost"; // Cambia a tu IP si accedes desde fuera

const EXPORT_DIR = path.join(__dirname, "exports");
// Crear carpeta si no existe
if (!fsSync.existsSync(EXPORT_DIR)) {
  fsSync.mkdirSync(EXPORT_DIR);
}

// ==================================================================================
//  CLIENTE OPENAI - GPT
// ==================================================================================
let _openaiClient = null;

function getOpenAIClient() {
  if (!_openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY || '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';
    _openaiClient = new OpenAI({ apiKey });
    console.log("✅ Cliente OpenAI inicializado correctamente");
  }
  return _openaiClient;
}
const app = express();
app.use(cors());
app.use(express.json());
// Servir archivos estáticos para descargas
app.use("/downloads", express.static(EXPORT_DIR));

let movements = []; 

// ==================================================================================
//  MÓDULO 1: GENERADOR DE EXCEL (CSV) - FORMATO INGENIERO
// ==================================================================================
function generateCSV(data, searchTerm = "", hidePrices = false) {
  // Cabecera dinámica con todas las columnas necesarias
  let header = "ID_UBICACION;MARCA;TEMPORADAS;STOCK_TOTAL_UBICACION";
  
  if (!hidePrices) header += ";VALOR_STOCK_€"; 
  
  header += ";CLASES_ABC;DIAS_MAX;OCUPACION_%";
  
  if (searchTerm) header += ";STOCK_EXACTO_BUSQUEDA"; 
  
  // Columnas de desglose de contenido
  header += ";PRODUCTOS_A;PRODUCTOS_B;PRODUCTOS_C;PRODUCTOS_D\n";

  const rows = data.map(loc => {
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

    const prodA = loc.packages.filter(p => p.abcClass === 'A').map(formatPack).join(" | ");
    const prodB = loc.packages.filter(p => p.abcClass === 'B').map(formatPack).join(" | ");
    const prodC = loc.packages.filter(p => p.abcClass === 'C').map(formatPack).join(" | ");
    const prodD = loc.packages.filter(p => p.abcClass === 'D' || !p.abcClass).map(formatPack).join(" | ");
    
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
//  MÓDULO 2: MOTOR DE INGENIERÍA (AGREGACIÓN + FILTROS + COPILOT)
// ==================================================================================
async function queryWarehouseData(locations, filters) {
  console.log(" ⚙️  [MOTOR] Procesando Filtros Avanzados:", filters);

  // 1. FILTRADO DE UBICACIONES (Nivel Macro)
  let results = locations.filter(loc => {
    // Estado
    if (filters.status === "EMPTY" && (loc.totalStock || 0) > 0) return false;
    if (filters.status === "OCCUPIED" && (loc.totalStock || 0) === 0) return false;
    
    // Marca
    if (filters.brand && filters.brand !== "ALL") { 
        if (!loc.id.includes(filters.brand)) return false; 
    }
    
    // Antigüedad
    if (filters.min_days_old) { 
        if (!loc.packages || !loc.packages.some(p => p.daysOld >= filters.min_days_old)) return false; 
    }
    
    // ABC (Si la ubicación contiene AL MENOS un producto de esa clase)
    if (filters.abc_class) { 
        if (!loc.packages || !loc.packages.some(p => p.abcClass === filters.abc_class)) return false; 
    }
    
    // TEMPORADA
    if (filters.season) {
        // Si la ubicación no tiene NINGÚN paquete de esa temporada, fuera
        if (!loc.packages || !loc.packages.some(p => p.season === filters.season)) return false;
    }

    // Búsqueda Texto
    if (filters.search_text) {
      const q = filters.search_text.toLowerCase();
      const contentStr = JSON.stringify(loc.packages).toLowerCase();
      if (!contentStr.includes(q) && !loc.id.toLowerCase().includes(q)) return false;
    }
    
    // Velocidad (Slotting)
    if (filters.min_velocity) {
        if ((loc.velocityScore || 0) < filters.min_velocity) return false;
    }

    return true;
  });

  // Auditoría de Mezclas (Ingeniería)
  if (filters.check_mixing_a_d) {
    results = results.filter(loc => {
      if (!loc.packages) return false;
      const classes = loc.packages.map(p => p.abcClass || "D");
      // Solo pasa si tiene A Y TAMBIÉN (D o C)
      return classes.includes("A") && (classes.includes("D") || classes.includes("C"));
    });
  }

  // 2. AGREGACIÓN MATEMÁTICA POR PRODUCTO (Nivel Micro - EL CEREBRO)
  // Este es el bloque que cuenta unidades exactas para evitar alucinaciones.
  const productAggregator = {};
  let totalValueSelection = 0;

  results.forEach(loc => {
      if (!loc.packages) return;
      
      let matchQtyLoc = 0; // Contador para la ubicación actual
      
      loc.packages.forEach(pkg => {
          // Aplicamos los filtros también al paquete individual para sumar solo lo que toca
          if (filters.abc_class && pkg.abcClass !== filters.abc_class) return;
          if (filters.season && pkg.season !== filters.season) return;
          
          if (filters.search_text) {
              const str = (pkg.surtido || "" + pkg.productCode).toLowerCase();
              if (!str.includes(filters.search_text.toLowerCase())) return;
          }

          // Datos del paquete
          const ref = pkg.surtido || pkg.productCode || "SIN_REF";
          const qty = pkg.qty || 0;
          const cost = pkg.cost || 0;
          const vel = pkg.velocity || 0;
          const seas = pkg.season || "N/A";

          // Agregamos al mapa global de productos
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
          
          productAggregator[ref].total_qty += qty;
          
          if (!filters.hide_prices) {
            productAggregator[ref].total_val += (qty * cost);
            totalValueSelection += (qty * cost);
          }
          
          matchQtyLoc += qty;
      });
      
      // Guardamos el dato exacto en la ubicación para el Excel
      loc.matchQty = matchQtyLoc;
  });

  // 3. CONSTRUIR EL CHIVATO PARA LA IA (TOP PRODUCTOS)
  const topProductsList = Object.values(productAggregator).map(p => {
      let coverage = "Infinito";
      if (p.velocity > 0) coverage = Math.round(p.total_qty / p.velocity) + " días";
      else if (p.total_qty > 0) coverage = "Sin ventas (Riesgo)";
      
      // Limpieza por privacidad
      if (filters.hide_prices) delete p.total_val;
      
      return { ...p, coverage };
  });

  // Ordenamos por cantidad total (Lo que más hay, primero)
  topProductsList.sort((a, b) => b.total_qty - a.total_qty);

  // Ordenamos también las ubicaciones para que el Excel salga ordenado
  results.sort((a, b) => b.matchQty - a.matchQty);

  // 4. PREPARAR RESPUESTA
  const totalCount = results.length; // Ubicaciones encontradas
  const totalStockFiltered = topProductsList.reduce((acc, p) => acc + p.total_qty, 0); // Suma real de productos

  // Extraemos la lista de IDs para el Mapa Copilot (Iluminación)
  const foundIds = results.map(r => r.id);

  const response = {
      summary: {
          found: true,
          count_locations: totalCount,
          total_stock_units: totalStockFiltered,
          note: "Cálculos matemáticos verificados."
      },
      // EL DATO QUE USA LA IA PARA NO INVENTAR
      top_products_summary: topProductsList.slice(0, 10),
      // EL DATO QUE USA EL MAPA PARA ILUMINARSE
      found_ids: foundIds
  };

  if (!filters.hide_prices) {
      response.summary.total_value_eur = totalValueSelection.toFixed(2);
  } else {
      response.summary.privacy_mode = "ACTIVADO";
  }

  // 5. EXPORTACIÓN INTELIGENTE
  if (filters.export_csv === true || (filters.auto_export_if_large && totalCount > 50)) {
    console.log(` 📂  Generando Excel Masivo (${totalCount} filas)...`);
    const filename = `report_ingenieria_${Date.now()}.csv`;
    const filePath = path.join(EXPORT_DIR, filename);
    
    await fs.writeFile(filePath, generateCSV(results, filters.search_text, filters.hide_prices), 'utf8');
    
    response.summary.action = "FILE_GENERATED";
    response.summary.download_link = `http://${SERVER_HOST}:${PORT}/downloads/${filename}`;
    response.summary.message = "He procesado los datos masivos. Te paso el resumen TOP 10, los IDs para el mapa y el archivo completo.";
  }

  return JSON.stringify(response);
}

// ==================================================================================
//  MÓDULO 3: MOTOR DE INTELIGENCIA DE NEGOCIO (BI - VENTAS)
// ==================================================================================
async function analyzeSalesData(args) {
  console.log(" 💰  [BI] Analizando Ventas Odoo:", args);
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

    // Lógica de Marcas (Igual que en Sync)
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
//  MÓDULO 4: ANÁLISIS DETALLADO DE LOGÍSTICA
// ==================================================================================
async function queryDetailedData(args) {
  console.log(" 📦  [LOGÍSTICA] Analizando datos detallados:", args);
  const dataPath = path.join(__dirname, "data", "locations.json");
  const raw = await fs.readFile(dataPath, "utf8");
  const allLocations = JSON.parse(raw);
  
  // Usar queryWarehouseData para obtener ubicaciones filtradas
  const result = await queryWarehouseData(allLocations, args);
  return result;
}

// ==================================================================================
//  ⭐ MÓDULO PACKING LIST ANALYZER v4.0 - CON INTELIGENCIA
// ==================================================================================

const packingStorage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const packingUpload = multer({ storage: packingStorage, limits: { fileSize: 50 * 1024 * 1024 } });

if (!fsSync.existsSync('./uploads')) fsSync.mkdirSync('./uploads', { recursive: true });
if (!fsSync.existsSync('./packing-outputs')) fsSync.mkdirSync('./packing-outputs', { recursive: true });

// Caché de Odoo
let packingProductCache = new Map();
let packingAbcCache = new Map();
let packingStockCache = new Map();
let packingLastCacheUpdate = null;

// Caché de análisis (por hash de PDF)
let packingAnalysisCache = new Map();

async function calculatePDFHash(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  return crypto.createHash('md5').update(fileBuffer).digest('hex');
}

async function refreshPackingCache() {
  console.log('📦 [PACKING] Actualizando caché Odoo...');
  const startTime = Date.now();

  try {
    const odooUrl = process.env.ODOO_URL || 'https://professional.illice.com';
    const odooDb = 'blackdivision';
    const odooUsername = process.env.ODOO_USERNAME || 'j.bernabe@illice.com';
    const odooPassword = process.env.ODOO_PASSWORD || '98b68f64a4ee2fd5362f16f3b0427a629877f80f';
    
    const common = xmlrpc.createSecureClient({ url: `${odooUrl}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${odooUrl}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        odooDb, odooUsername, odooPassword, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    console.log('  📦 Descargando productos...');
    const products = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        odooDb, uid, odooPassword,
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
          odooDb, uid, odooPassword,
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
        odooDb, uid, odooPassword,
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
//  PARSER PDF CON GPT-4o + INTELIGENCIA
// ==================================================================================
async function parsePackingPDFWithAI(filePath) {
  console.log('🧠 [PACKING-AI v4.0] Iniciando análisis con GPT-4o + Inteligencia...');
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

    // Construir contenido para IA
    let contentForAI = `DOCUMENTO DE ${extracted.page_count} PÁGINAS\n`;
    contentForAI += `CONTENEDORES DETECTADOS: ${extracted.container_candidates.join(', ') || 'Ninguno'}\n\n`;
    
    extracted.tables.forEach((table, idx) => {
      const tableStr = table.map(row => row.join(' | ')).join('\n');
      contentForAI += `\n=== TABLA ${idx + 1} ===\n${tableStr}\n`;
    });
    
    if (extracted.tables.length === 0 || contentForAI.length < 2000) {
      contentForAI += `\n=== TEXTO COMPLETO ===\n${extracted.raw_text}`;
    }
    
    if (contentForAI.length > 80000) contentForAI = contentForAI.substring(0, 80000);

    // Generar prompt inteligente con contexto
    const smartPrompt = packingIntelligence.generateSmartPrompt(contentForAI);

    console.log(`  🤖 Enviando a GPT-4o...`);
    
    const openai = getOpenAIClient();
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 16384,
      temperature: 0.1,
      messages: [
        { role: "user", content: smartPrompt }
      ]
    });

    let aiText = aiResponse.choices[0].message.content || '';
    console.log('📝 [GPT-4o RAW RESPONSE]:', aiText.substring(0, 2000));
    
    let parsedAI;
    try {
      // Extraer JSON de la respuesta
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      parsedAI = jsonMatch ? JSON.parse(jsonMatch[0]) : { items: [], confidence: "LOW" };
    } catch (e) {
      console.error('  ⚠️ Error parseando JSON:', e.message);
      console.log('  📝 Respuesta IA:', aiText.substring(0, 500));
      parsedAI = { items: [], confidence: "LOW" };
    }
    
    // Asegurar container_number
    if (!parsedAI.container_number && extracted.container_candidates.length > 0) {
      parsedAI.container_number = extracted.container_candidates[0];
    }

    // Normalizar colores
    if (parsedAI.items) {
      parsedAI.items = parsedAI.items.map(item => {
        let ref = item.reference || '';
        if (ref.includes('-')) {
          const parts = ref.split('-');
          ref = `${parts[0]}-${packingIntelligence.normalizeColor(parts.slice(1).join('-'))}`;
        }
        return { 
          ...item, 
          reference: ref.toUpperCase(),
          totalUnits: item.quantity || item.totalUnits || 0,
          totalBoxes: item.cartons || item.totalBoxes || 0
        };
      });
    }
    
    console.log(`  ✅ ${parsedAI.items?.length || 0} líneas extraídas (Confidence: ${parsedAI.confidence})`);
    console.log(`  📦 Total: ${parsedAI.total_units || 'N/A'} uds, ${parsedAI.total_cartons || 'N/A'} cajas`);
    
    return parsedAI;
  } catch (error) {
    await fs.unlink(tempScriptPath).catch(() => {});
    throw error;
  }
}

// ==================================================================================
//  ENRIQUECIMIENTO CON ODOO + INTELIGENCIA
// ==================================================================================
function enrichPackingListAI(parsedData) {
  // Usar sistema de inteligencia para enriquecer
  const odooCache = {
    products: packingProductCache,
    abc: packingAbcCache,
    stock: packingStockCache
  };
  
  const enriched = packingIntelligence.enrichParsedData(parsedData, odooCache);
  const summary = packingIntelligence.generateSummary(enriched.items || []);
  
  // Ordenar items
  if (enriched.items) {
    enriched.items.sort((a, b) => {
      if (a.reference !== b.reference) return a.reference.localeCompare(b.reference);
      return 0;
    });
  }
  
  console.log(`  📊 ${enriched.items?.length || 0} líneas enriquecidas`);
  console.log(`  📦 Total: ${summary.totalUnits} uds, ${summary.totalBoxes} cajas, ${summary.totalPallets} palets`);

  return { items: enriched.items || [], summary };
}

// ==================================================================================
//  ENDPOINTS PACKING
// ==================================================================================
app.get("/api/packing/health", (req, res) => {
  const stats = packingIntelligence.getStats();
  res.json({
    status: 'ok', 
    version: '4.0-GPT-INTELLIGENCE',
    cache: { 
      odoo: { 
        products: packingProductCache.size, 
        abc: packingAbcCache.size, 
        stock: packingStockCache.size, 
        lastUpdate: packingLastCacheUpdate 
      },
      analysis: { 
        count: packingAnalysisCache.size, 
        maxSize: 100 
      }
    },
    intelligence: stats
  });
});

app.get("/api/packing/intelligence/stats", (req, res) => {
  res.json({
    stats: packingIntelligence.getStats(),
    recentAnalyses: packingIntelligence.getRecentAnalyses(10)
  });
});

app.get("/api/packing/intelligence/reference/:ref", (req, res) => {
  const info = packingIntelligence.getReferenceInfo(req.params.ref);
  if (info) {
    res.json({ found: true, reference: req.params.ref, data: info });
  } else {
    res.json({ found: false, reference: req.params.ref });
  }
});

app.get("/api/packing/intelligence/search", (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Parámetro q requerido' });
  const results = packingIntelligence.searchReferences(q);
  res.json({ query: q, results });
});

app.post("/api/packing/cache/refresh", async (req, res) => {
  try {
    const stats = await refreshPackingCache();
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/packing/cache/clear", async (req, res) => {
  packingAnalysisCache.clear();
  res.json({ success: true, message: 'Caché de análisis limpiada' });
});

app.post("/api/packing/analyze", packingUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    
    const forceReanalyze = req.query.force === 'true';
    console.log(`\n📄 [PACKING v4.0] Analizando: ${req.file.originalname}${forceReanalyze ? ' (FORZADO)' : ''}`);

    // Calcular hash del PDF
    const pdfHash = await calculatePDFHash(req.file.path);
    console.log(`  🔑 Hash: ${pdfHash.substring(0, 12)}...`);

    // Verificar caché
    if (!forceReanalyze && packingAnalysisCache.has(pdfHash)) {
      const cached = packingAnalysisCache.get(pdfHash);
      console.log(`  ⚡ CACHE HIT! (${cached.items?.length || 0} líneas)`);
      await fs.unlink(req.file.path).catch(() => {});
      return res.json({ ...cached, fromCache: true, cacheDate: cached.analyzedAt });
    }

    // Actualizar caché Odoo si es necesario
    if (!packingLastCacheUpdate || (Date.now() - packingLastCacheUpdate.getTime()) > 3600000) {
      try { await refreshPackingCache(); } catch (e) { console.warn('⚠️ Cache Odoo no actualizada'); }
    }

    // Analizar con IA
    const parsed = await parsePackingPDFWithAI(req.file.path);
    const containerNumber = parsed.container_number || req.file.originalname.match(/[A-Z]{4}\d{7}/)?.[0] || 'UNKNOWN';
    
    // Enriquecer con Odoo + Inteligencia
    const enriched = enrichPackingListAI(parsed);

    // APRENDER de este análisis
    packingIntelligence.learnFromAnalysis(containerNumber, enriched.items, true);

    // Construir resultado
    const result = {
      success: true,
      containerNumber,
      summary: enriched.summary,
      items: enriched.items,
      groupedTotals: enriched.summary.groupedTotals,
      aiPowered: true,
      model: 'GPT-4o',
      intelligenceVersion: '4.0',
      analyzedAt: new Date().toISOString(),
      fileName: req.file.originalname
    };
    
    // Guardar en caché
    packingAnalysisCache.set(pdfHash, result);
    
    // Limpiar archivo temporal
    await fs.unlink(req.file.path).catch(() => {});
    
    console.log(`✅ [PACKING] Completado: ${enriched.items.length} líneas (aprendizaje actualizado)\n`);

    res.json({ ...result, fromCache: false });
  } catch (error) {
    console.error('❌ [PACKING] Error:', error);
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    
    // Registrar fallo en inteligencia
    packingIntelligence.learnFromAnalysis('ERROR', [], false);
    
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/packing/download/:filename", (req, res) => {
  res.download(path.join(__dirname, 'packing-outputs', req.params.filename));
});

// --- DEFINICIÓN DE HERRAMIENTAS PARA GPT-4o ---
const tools = [
  {
    type: "function",
    function: {
      name: "consultar_almacen",
      description: "Herramienta TOTAL. Busca Stock, Filtra por Temporada/ABC/Marca, devuelve IDs para el mapa y Exporta Excel.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ALL", "EMPTY", "OCCUPIED"] },
          brand: { type: "string", enum: ["ALL", "BD", "GD", "WD"] },
          search_text: { type: "string" },
          min_days_old: { type: "number" },
          abc_class: { type: "string", enum: ["A", "B", "C", "D"] },
          season: { type: "string", description: "Filtra por Temporada (ej: 'V26', 'I23')." },
          min_velocity: { type: "number" },
          check_mixing_a_d: { type: "boolean" },
          hide_prices: { type: "boolean" },
          export_csv: { type: "boolean" },
          auto_export_if_large: { type: "boolean" }
        },
        required: ["auto_export_if_large"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analizar_ventas",
      description: "Consulta VENTAS reales (Odoo BI).",
      parameters: {
        type: "object",
        properties: { 
            days_back: { type: "number" },
            hide_prices: { type: "boolean" }
        },
        required: ["days_back"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_logistics",
      description: "Análisis detallado de logística y almacén.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ALL", "EMPTY", "OCCUPIED"] },
          brand: { type: "string", enum: ["ALL", "BD", "GD", "WD"] },
          search_text: { type: "string" },
          min_days_old: { type: "number" },
          abc_class: { type: "string", enum: ["A", "B", "C", "D"] },
          season: { type: "string" },
          min_velocity: { type: "number" },
          check_mixing_a_d: { type: "boolean" },
          hide_prices: { type: "boolean" },
          export_csv: { type: "boolean" },
          auto_export_if_large: { type: "boolean" }
        },
        required: ["auto_export_if_large"],
      },
    },
  },
];

// ==================================================================================
//  ⭐ ENDPOINTS PARA INFORMES SEMANALES/MENSUALES - v2
//  Añadir este código a tu server.js del Gemelo Digital ANTES de server.listen()
// ==================================================================================

// ==================================================================================
//  HELPER: Leer devoluciones (con manejo de errores)
// ==================================================================================
async function getDevolucionesForReports() {
  try {
    // Intentar leer del archivo de devoluciones si existe
    const devolucionesPath = path.join(__dirname, "data", "devoluciones.json");
    
    // Verificar si el archivo existe
    try {
      await fs.access(devolucionesPath);
      const raw = await fs.readFile(devolucionesPath, "utf8");
      const data = JSON.parse(raw);
      // Si es un array, devolverlo directamente
      // Si tiene una propiedad con las devoluciones, extraerla
      if (Array.isArray(data)) {
        return data;
      } else if (data.devoluciones) {
        return data.devoluciones;
      } else if (data.items) {
        return data.items;
      }
      return [];
    } catch (e) {
      // Archivo no existe, devolver array vacío
      console.log('📦 [REPORTS] No existe archivo devoluciones.json, devolviendo vacío');
      return [];
    }
  } catch (error) {
    console.error('❌ [REPORTS] Error leyendo devoluciones:', error);
    return [];
  }
}

// ==================================================================================
//  1. OCUPACIÓN DEL ALMACÉN (para informe)
// ==================================================================================
app.get("/api/reports/ocupacion", async (req, res) => {
  try {
    console.log('📊 [REPORTS] Extrayendo ocupación para informe...');
    
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    // Calcular métricas globales
    let totalUbicaciones = locations.length;
    let ubicacionesOcupadas = 0;
    let ubicacionesVacias = 0;
    let stockTotal = 0;
    let valorTotal = 0;
    
    // Agrupar por marca
    const porMarca = {};
    // Agrupar por mercado/división (BD=Black, GD=Gold, WD=White)
    const porMercado = { BLACK: { ocupadas: 0, total: 0, stock: 0 }, GOLD: { ocupadas: 0, total: 0, stock: 0 }, WHITE: { ocupadas: 0, total: 0, stock: 0 }, OTROS: { ocupadas: 0, total: 0, stock: 0 } };
    
    locations.forEach(loc => {
      const stock = loc.totalStock || 0;
      const ocupada = stock > 0;
      
      if (ocupada) {
        ubicacionesOcupadas++;
      } else {
        ubicacionesVacias++;
      }
      
      stockTotal += stock;
      
      // Calcular valor
      if (loc.packages) {
        loc.packages.forEach(pkg => {
          valorTotal += (pkg.qty || 0) * (pkg.cost || 0);
        });
      }
      
      // Detectar mercado por prefijo de ubicación
      let mercado = 'OTROS';
      const locId = (loc.id || '').toUpperCase();
      if (locId.includes('BD') || locId.includes('BLACK') || locId.startsWith('CLA-BD')) mercado = 'BLACK';
      else if (locId.includes('GD') || locId.includes('GOLD') || locId.startsWith('CLA-GD') || locId.startsWith('CLAGD')) mercado = 'GOLD';
      else if (locId.includes('WD') || locId.includes('WHITE') || locId.startsWith('CLA-WD')) mercado = 'WHITE';
      
      porMercado[mercado].total++;
      if (ocupada) porMercado[mercado].ocupadas++;
      porMercado[mercado].stock += stock;
      
      // Por marca (brand del paquete)
      const marca = loc.brand || 'SIN_MARCA';
      if (!porMarca[marca]) {
        porMarca[marca] = { ocupadas: 0, total: 0, stock: 0, valor: 0 };
      }
      porMarca[marca].total++;
      if (ocupada) porMarca[marca].ocupadas++;
      porMarca[marca].stock += stock;
      
      if (loc.packages) {
        loc.packages.forEach(pkg => {
          porMarca[marca].valor += (pkg.qty || 0) * (pkg.cost || 0);
        });
      }
    });
    
    // Calcular porcentajes
    const ocupacionPct = totalUbicaciones > 0 ? (ubicacionesOcupadas / totalUbicaciones * 100) : 0;
    
    Object.keys(porMercado).forEach(m => {
      porMercado[m].porcentaje = porMercado[m].total > 0 
        ? (porMercado[m].ocupadas / porMercado[m].total * 100).toFixed(1)
        : 0;
    });
    
    Object.keys(porMarca).forEach(m => {
      porMarca[m].porcentaje = porMarca[m].total > 0
        ? (porMarca[m].ocupadas / porMarca[m].total * 100).toFixed(1)
        : 0;
    });
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      resumen: {
        ocupacion_total_pct: parseFloat(ocupacionPct.toFixed(1)),
        ubicaciones_ocupadas: ubicacionesOcupadas,
        ubicaciones_vacias: ubicacionesVacias,
        ubicaciones_totales: totalUbicaciones,
        stock_total_unidades: stockTotal,
        valor_total_eur: parseFloat(valorTotal.toFixed(2))
      },
      por_mercado: porMercado,
      por_marca: porMarca
    });
    
  } catch (error) {
    console.error('❌ [REPORTS] Error ocupación:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================================================================================
//  2. DEVOLUCIONES (para informe) - VERSIÓN CORREGIDA
// ==================================================================================
app.get("/api/reports/devoluciones", async (req, res) => {
  try {
    console.log('📦 [REPORTS] Extrayendo devoluciones para informe...');
    
    const { desde, hasta } = req.query;
    
    // Fechas por defecto: última semana
    const fechaHasta = hasta ? new Date(hasta) : new Date();
    const fechaDesde = desde ? new Date(desde) : new Date(fechaHasta.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Leer devoluciones del JSON (con manejo de errores)
    const devoluciones = await getDevolucionesForReports();
    
    // Si no hay devoluciones, devolver respuesta vacía pero válida
    if (!devoluciones || devoluciones.length === 0) {
      console.log('📦 [REPORTS] No hay devoluciones registradas');
      return res.json({
        success: true,
        timestamp: new Date().toISOString(),
        periodo: {
          desde: fechaDesde.toISOString().split('T')[0],
          hasta: fechaHasta.toISOString().split('T')[0]
        },
        entrada: { total: 0, b2b: 0, b2c: 0 },
        procesadas: { total: 0, b2b: 0, b2c: 0 },
        metricas: {
          ratio_procesamiento_pct: 100,
          pendientes_estimados: 0
        },
        por_dia: {},
        por_company: {},
        detalle_ultimas: [],
        mensaje: "No hay devoluciones registradas en el sistema"
      });
    }
    
    // Filtrar por rango de fechas
    const filtradas = devoluciones.filter(d => {
      const fechaField = d.fecha_recepcion || d.fecha || d.date || d.created_at;
      if (!fechaField) return false;
      const fecha = new Date(fechaField);
      return fecha >= fechaDesde && fecha <= fechaHasta;
    });
    
    // Separar B2B y B2C
    const b2b = filtradas;
    const b2c = [];
    
    // Agrupar por día
    const porDia = {};
    filtradas.forEach(d => {
      const fechaField = d.fecha_recepcion || d.fecha || d.date || d.created_at;
      if (!fechaField) return;
      const dia = fechaField.split('T')[0];
      if (!porDia[dia]) {
        porDia[dia] = { b2b: 0, b2c: 0, total: 0 };
      }
      porDia[dia].b2b++;
      porDia[dia].total++;
    });
    
    // Agrupar por empresa/división
    const porCompany = {};
    filtradas.forEach(d => {
      const company = d.company || d.empresa || 'Sin empresa';
      porCompany[company] = (porCompany[company] || 0) + 1;
    });
    
    // Calcular métricas
    const totalEntrada = filtradas.length;
    const procesadas = filtradas.filter(d => 
      d.estado === 'procesado' || d.status === 'processed' || d.state === 'done'
    ).length;
    const pendientes = filtradas.filter(d => 
      d.estado === 'recibido' || d.estado === 'pendiente' || d.status === 'pending'
    ).length;
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      periodo: {
        desde: fechaDesde.toISOString().split('T')[0],
        hasta: fechaHasta.toISOString().split('T')[0]
      },
      entrada: {
        total: totalEntrada,
        b2b: b2b.length,
        b2c: b2c.length
      },
      procesadas: {
        total: procesadas,
        b2b: procesadas,
        b2c: 0
      },
      metricas: {
        ratio_procesamiento_pct: totalEntrada > 0 ? parseFloat((procesadas / totalEntrada * 100).toFixed(1)) : 100,
        pendientes_estimados: pendientes
      },
      por_dia: porDia,
      por_company: porCompany,
      detalle_ultimas: filtradas.slice(0, 20).map(d => ({
        id: d.id,
        albaran: d.picking_name || d.albaran || d.name,
        cliente: d.partner_name || d.cliente,
        company: d.company || d.empresa,
        fecha: d.fecha_recepcion || d.fecha || d.date,
        estado: d.estado || d.status || d.state
      }))
    });
    
  } catch (error) {
    console.error('❌ [REPORTS] Error devoluciones:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================================================================================
//  3. RESUMEN COMPLETO PARA INFORME (un solo endpoint con todo)
// ==================================================================================
app.get("/api/reports/informe-semanal", async (req, res) => {
  try {
    console.log('📋 [REPORTS] Generando datos completos para informe semanal...');
    
    const { semana } = req.query; // Formato: YYYY-WXX (ej: 2025-W02)
    
    // Calcular fechas de la semana
    let fechaDesde, fechaHasta;
    if (semana) {
      const [year, week] = semana.split('-W').map(Number);
      fechaDesde = getDateOfISOWeek(week, year);
      fechaHasta = new Date(fechaDesde.getTime() + 6 * 24 * 60 * 60 * 1000);
    } else {
      // Semana actual
      const hoy = new Date();
      const diaSemana = hoy.getDay() || 7;
      fechaDesde = new Date(hoy);
      fechaDesde.setDate(hoy.getDate() - diaSemana + 1);
      fechaDesde.setHours(0, 0, 0, 0);
      fechaHasta = new Date(fechaDesde);
      fechaHasta.setDate(fechaDesde.getDate() + 6);
      fechaHasta.setHours(23, 59, 59, 999);
    }
    
    // Cargar datos de ubicaciones
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    // Cargar devoluciones (con manejo de errores)
    const devoluciones = await getDevolucionesForReports();
    
    // --- OCUPACIÓN ---
    let ubicacionesOcupadas = 0;
    let stockTotal = 0;
    let valorTotal = 0;
    const porMercado = { BLACK: { ocupadas: 0, total: 0 }, GOLD: { ocupadas: 0, total: 0 }, WHITE: { ocupadas: 0, total: 0 } };
    
    locations.forEach(loc => {
      const stock = loc.totalStock || 0;
      const ocupada = stock > 0;
      if (ocupada) ubicacionesOcupadas++;
      stockTotal += stock;
      
      if (loc.packages) {
        loc.packages.forEach(pkg => {
          valorTotal += (pkg.qty || 0) * (pkg.cost || 0);
        });
      }
      
      // Mercado
      const locId = (loc.id || '').toUpperCase();
      let mercado = null;
      if (locId.includes('BD') || locId.startsWith('CLA-BD')) mercado = 'BLACK';
      else if (locId.includes('GD') || locId.startsWith('CLA-GD') || locId.startsWith('CLAGD')) mercado = 'GOLD';
      else if (locId.includes('WD') || locId.startsWith('CLA-WD')) mercado = 'WHITE';
      
      if (mercado) {
        porMercado[mercado].total++;
        if (ocupada) porMercado[mercado].ocupadas++;
      }
    });
    
    // --- DEVOLUCIONES (filtradas por semana) ---
    let devsEntrada = 0;
    let devsProcesadas = 0;
    
    if (devoluciones && devoluciones.length > 0) {
      const devsSemana = devoluciones.filter(d => {
        const fechaField = d.fecha_recepcion || d.fecha || d.date || d.created_at;
        if (!fechaField) return false;
        const fecha = new Date(fechaField);
        return fecha >= fechaDesde && fecha <= fechaHasta;
      });
      
      devsEntrada = devsSemana.length;
      devsProcesadas = devsSemana.filter(d => 
        d.estado === 'procesado' || d.status === 'processed' || d.state === 'done'
      ).length;
    }
    
    // --- RESULTADO ---
    res.json({
      success: true,
      generado_en: new Date().toISOString(),
      periodo: {
        tipo: 'semanal',
        desde: fechaDesde.toISOString().split('T')[0],
        hasta: fechaHasta.toISOString().split('T')[0]
      },
      ocupacion_almacen: {
        ocupacion_total_pct: locations.length > 0 ? parseFloat((ubicacionesOcupadas / locations.length * 100).toFixed(1)) : 0,
        ubicaciones_ocupadas: ubicacionesOcupadas,
        ubicaciones_totales: locations.length,
        stock_unidades: stockTotal,
        valor_eur: parseFloat(valorTotal.toFixed(2)),
        por_mercado: Object.fromEntries(
          Object.entries(porMercado).map(([k, v]) => [
            k, 
            { ...v, porcentaje: v.total > 0 ? parseFloat((v.ocupadas / v.total * 100).toFixed(1)) : 0 }
          ])
        )
      },
      devoluciones: {
        entrada: { total: devsEntrada, b2b: devsEntrada, b2c: 0 },
        procesadas: { total: devsProcesadas, b2b: devsProcesadas, b2c: 0 },
        ratio_procesamiento_pct: devsEntrada > 0 ? parseFloat((devsProcesadas / devsEntrada * 100).toFixed(1)) : 100,
        pendientes: devsEntrada - devsProcesadas
      }
    });
    
  } catch (error) {
    console.error('❌ [REPORTS] Error informe semanal:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper para calcular fecha de semana ISO
function getDateOfISOWeek(week, year) {
  const simple = new Date(year, 0, 1 + (week - 1) * 7);
  const dow = simple.getDay();
  const ISOweekStart = simple;
  if (dow <= 4)
    ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
  else
    ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());
  return ISOweekStart;
}

// ==================================================================================
//  FIN ENDPOINTS REPORTS v2
// ==================================================================================

// ==================================================================================
//  ENDPOINT: STRATEGIC CHAT
// ==================================================================================
app.post("/api/strategic-chat", async (req, res) => {
  try {
    const { message, history } = req.body;
    console.log(` 💬  [STRATEGIC CHAT] Procesando: "${message}"`);

    const systemPrompt = `Eres un asistente estratégico de logística y gestión de almacén. 
Proporciona análisis estratégicos, recomendaciones y respuestas detalladas sobre operaciones de almacén, 
gestión de inventario, optimización de procesos y toma de decisiones empresariales.`;

    const claudeMessages = (history || []).map(m => ({
      role: m.role === 'ai' ? 'assistant' : 'user',
      content: m.content
    }));

    const openai = getOpenAIClient();
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        ...claudeMessages,
        { role: "user", content: message }
      ]
    });

    const answer = response.choices[0].message.content;

    res.json({ text: answer });
  } catch (err) {
    console.error(" ❌  Error Strategic Chat:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================================================================================
//  AGENTE DE INTELIGENCIA ARTIFICIAL (ENDPOINT)
// ==================================================================================
app.post("/api/ai/report", async (req, res) => {
  try {
    const { query, history } = req.body;
    console.log(` 🤖  [AGENTE] Procesando: "${query}"`);
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const allLocations = JSON.parse(raw);

    const SYSTEM_PROMPT = `
      Eres una IA de Ingeniería Logística y Financiera (Nivel Experto).
      
      REGLAS OPERATIVAS:
      1. **ILUMINACIÓN DEL MAPA:** Si el usuario dice "Ilumina", "Muestra en el mapa" o "Dónde están", tu respuesta JSON incluirá automáticamente los IDs para iluminar el mapa. Tú solo confirma: "He iluminado las X ubicaciones en el mapa".
      2. **DATOS REALES:** Usa SIEMPRE 'top_products_summary' para responder cantidades. NO sumes tú.
      3. **PRIVACIDAD:** Si 'hide_prices' es true, no hables de dinero.
      4. **ARCHIVOS:** Si hay archivo, di: "📥 **[Descargar Informe] (LINK)**".
    `;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(history || []).map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content })),
      { role: "user", content: query }
    ];

    const openai = getOpenAIClient();
    
    // Convertir tools de formato OpenAI (ya están en formato correcto)
    const openaiTools = tools;

    let response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4096,
      messages: messages,
      tools: openaiTools,
      tool_choice: "auto"
    });

    let finalMapIds = [];

    while (response.choices[0].finish_reason === 'tool_calls') {
      const toolCalls = response.choices[0].message.tool_calls || [];
      const toolResults = [];

      for (const toolCall of toolCalls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
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

        } else if (fnName === 'analizar_ventas') {
          functionResult = await analyzeSalesData(args);
        
        } else if (fnName === 'analyze_logistics') {
          functionResult = await queryDetailedData(args);
          try {
            const parsed = JSON.parse(functionResult);
            if (Array.isArray(parsed)) {
              const ids = parsed.map(p => p.locationId);
              finalMapIds = [...finalMapIds, ...ids];
            } else if (parsed.found_ids) {
              finalMapIds = [...finalMapIds, ...parsed.found_ids];
            }
          } catch(e) { console.error("Error parseando logística:", e); }
        }

        toolResults.push({
          tool_call_id: toolCall.id,
          role: "tool",
          content: functionResult
        });
      }

      // Continuar conversación con resultados
      response = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 4096,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages.filter(m => m.role !== 'system'),
          response.choices[0].message,
          ...toolResults
        ],
        tools: openaiTools,
        tool_choice: "auto"
      });
    }

    const finalText = response.choices[0].message.content || "No se pudo generar respuesta.";

    // ENVIAMOS RESPUESTA MIXTA (TEXTO + COMANDO MAPA)
    res.json({ 
      text: finalText,
      map_highlight_ids: [...new Set(finalMapIds)],
      model: "GPT-4o"
    });
  } catch (err) {
    console.error(" ❌  Error Agente:", err.message);
    res.json({ text: `###  ⚠️  Error Técnico\n\n${err.message}` });
  }
});
// ==================================================================================
//  ENDPOINTS CRUD DEVOLUCIONES B2B
// ==================================================================================
const DEVOLUCIONES_PATH = path.join(__dirname, "data", "devoluciones.json");
// DEBUG: Verificar archivo devoluciones
app.get("/api/devoluciones/debug", async (req, res) => {
  try {
    const exists = fsSync.existsSync(DEVOLUCIONES_PATH);
    let content = null;
    let fileSize = null;
    
    if (exists) {
      const stats = fsSync.statSync(DEVOLUCIONES_PATH);
      fileSize = stats.size;
      const raw = await fs.readFile(DEVOLUCIONES_PATH, "utf8");
      content = raw.substring(0, 500); // Primeros 500 chars
    }
    
    res.json({
      path: DEVOLUCIONES_PATH,
      exists,
      fileSize,
      contentPreview: content,
      __dirname
    });
  } catch (e) {
    res.json({ error: e.message, path: DEVOLUCIONES_PATH });
  }
});
// Helper para leer devoluciones
async function readDevoluciones() {
  try {
    const raw = await fs.readFile(DEVOLUCIONES_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

// Helper para guardar devoluciones
async function saveDevoluciones(data) {
  await fs.writeFile(DEVOLUCIONES_PATH, JSON.stringify(data, null, 2), "utf8");
}

// GET /api/devoluciones - Listar devoluciones
app.get("/api/devoluciones", async (req, res) => {
  try {
    const { company, limit = 50 } = req.query;
    let devoluciones = await readDevoluciones();
    
    if (company) {
      devoluciones = devoluciones.filter(d => d.company?.toLowerCase() === company.toLowerCase());
    }
    
    devoluciones.sort((a, b) => new Date(b.fecha_recepcion) - new Date(a.fecha_recepcion));
    devoluciones = devoluciones.slice(0, parseInt(limit));
    
    res.json({ devoluciones });
  } catch (error) {
    console.error('❌ [DEVOLUCIONES] Error listando:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/devoluciones/stats - Estadísticas
app.get("/api/devoluciones/stats", async (req, res) => {
  try {
    const devoluciones = await readDevoluciones();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    const contadores = {
      hoy: devoluciones.filter(d => new Date(d.fecha_recepcion) >= today).length,
      semana: devoluciones.filter(d => new Date(d.fecha_recepcion) >= weekAgo).length,
      mes: devoluciones.filter(d => new Date(d.fecha_recepcion) >= monthAgo).length,
      total: devoluciones.length
    };
    
    const recentDevs = devoluciones.filter(d => new Date(d.fecha_recepcion) >= monthAgo);
    const porCompanyMap = {};
    recentDevs.forEach(d => {
      const c = d.company || 'Sin empresa';
      porCompanyMap[c] = (porCompanyMap[c] || 0) + 1;
    });
    const por_company = Object.entries(porCompanyMap).map(([company, count]) => ({ company, count }));
    
    const ultimas = devoluciones
      .sort((a, b) => new Date(b.fecha_recepcion) - new Date(a.fecha_recepcion))
      .slice(0, 5);
    
    res.json({ contadores, por_company, ultimas });
  } catch (error) {
    console.error('❌ [DEVOLUCIONES] Error stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/devoluciones/buscar - Buscar en Odoo
app.get("/api/devoluciones/buscar", async (req, res) => {
  try {
    const { q, tipo = 'todos' } = req.query;
    
    if (!q || q.length < 2) {
      return res.json({ resultados: [], error: 'Query muy corta' });
    }
    
    console.log(`🔍 [DEVOLUCIONES] Buscando "${q}" tipo=${tipo}`);
    
    const odooUrl = process.env.ODOO_URL || 'https://professional.illice.com';
    const odooDb = 'blackdivision';
    const odooUsername = process.env.ODOO_USERNAME || 'j.bernabe@illice.com';
    const odooPassword = process.env.ODOO_PASSWORD || '98b68f64a4ee2fd5362f16f3b0427a629877f80f';
    
    const common = xmlrpc.createSecureClient({ url: `${odooUrl}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${odooUrl}/xmlrpc/2/object` });
    
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [odooDb, odooUsername, odooPassword, {}], (err, res) => err ? reject(err) : resolve(res));
    });
    
    if (!uid) {
      return res.json({ resultados: [], error: 'Error autenticación Odoo' });
    }
    
    let domain = [];
    
    if (tipo === 'pedido') {
      domain = [['origin', 'ilike', q]];
    } else if (tipo === 'albaran') {
      domain = [['name', 'ilike', q]];
    } else if (tipo === 'cliente') {
      domain = [['partner_id.name', 'ilike', q]];
    } else if (tipo === 'paquete') {
      domain = [['name', 'ilike', q]];
    } else {
      domain = ['|', '|', '|', 
        ['name', 'ilike', q],
        ['origin', 'ilike', q],
        ['partner_id.name', 'ilike', q],
        ['carrier_tracking_ref', 'ilike', q]
      ];
    }
    
    domain.push(['picking_type_id.code', '=', 'outgoing']);
    
    const pickings = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        odooDb, uid, odooPassword,
        'stock.picking', 'search_read',
        [domain],
        { 
          fields: ['id', 'name', 'origin', 'partner_id', 'date_done', 'carrier_id', 'carrier_tracking_ref', 'company_id'],
          limit: 20,
          order: 'date_done desc'
        }
      ], (err, res) => err ? reject(err) : resolve(res));
    });
    
    const devoluciones = await readDevoluciones();
    const devPickingIds = new Set(devoluciones.map(d => d.picking_id));
    
    const resultados = pickings.map(p => {
      let company = 'Gold';
      if (p.name?.includes('CLABD')) company = 'Black';
      else if (p.name?.includes('CLAWD')) company = 'White';
      
      return {
        picking_id: p.id,
        albaran: p.name,
        pedido: p.origin,
        cliente: p.partner_id ? p.partner_id[1] : 'Sin cliente',
        fecha_envio: p.date_done,
        carrier: p.carrier_id ? p.carrier_id[1] : null,
        tracking: p.carrier_tracking_ref,
        company,
        devolucion_existente: devPickingIds.has(p.id) ? devoluciones.find(d => d.picking_id === p.id) : null
      };
    });
    
    console.log(`✅ [DEVOLUCIONES] ${resultados.length} resultados encontrados`);
    res.json({ resultados });
    
  } catch (error) {
    console.error('❌ [DEVOLUCIONES] Error buscando:', error);
    res.json({ resultados: [], error: error.message });
  }
});

// POST /api/devoluciones - Registrar nueva devolución
app.post("/api/devoluciones", async (req, res) => {
  try {
    const { picking_id, picking_name, partner_name, company, tracking_retorno, recibido_por, notas } = req.body;
    
    if (!picking_id || !picking_name) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios' });
    }
    
    const devoluciones = await readDevoluciones();
    
    if (devoluciones.some(d => d.picking_id === picking_id)) {
      return res.json({ success: false, error: 'Esta devolución ya está registrada' });
    }
    
    const maxId = devoluciones.reduce((max, d) => Math.max(max, d.id || 0), 0);
    const now = new Date();
    
    const nuevaDevolucion = {
      id: maxId + 1,
      picking_id,
      picking_name,
      partner_name,
      company,
      tracking_retorno: tracking_retorno || '',
      fecha_recepcion: now.toISOString().replace('T', ' ').substring(0, 19),
      recibido_por: recibido_por || 'Operario',
      notas: notas || '',
      created_at: now.toISOString().replace('T', ' ').substring(0, 19)
    };
    
    devoluciones.unshift(nuevaDevolucion);
    await saveDevoluciones(devoluciones);
    
    console.log(`✅ [DEVOLUCIONES] Registrada: ${picking_name} por ${recibido_por}`);
    res.json({ success: true, devolucion: nuevaDevolucion });
    
  } catch (error) {
    console.error('❌ [DEVOLUCIONES] Error registrando:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================================================================================
//  FIN ENDPOINTS DEVOLUCIONES
// ==================================================================================
// ==================================================================================
//  ENDPOINT OCUPACIÓN V2 - CON B2C Y B2B CORRECTOS
//  Añadir este código a tu server.js del Gemelo Digital
// ==================================================================================

app.get("/api/reports/ocupacion-v2", async (req, res) => {
  try {
    console.log('📊 [REPORTS] Extrayendo ocupación B2C/B2B para informe...');
    
    const dataPath = path.join(__dirname, "data", "locations.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const locations = JSON.parse(raw);
    
    // =========================================================================
    // FILTRAR B2C: Ubicaciones con "Storage" en el ID
    // =========================================================================
    const b2cLocations = locations.filter(loc => 
      (loc.id || '').includes('Storage')
    );
    
    const b2cOcupadas = b2cLocations.filter(loc => (loc.totalStock || 0) > 0).length;
    const b2cTotal = b2cLocations.length;
    const b2cStock = b2cLocations.reduce((sum, loc) => sum + (loc.totalStock || 0), 0);
    const b2cPct = b2cTotal > 0 ? (b2cOcupadas / b2cTotal * 100) : 0;
    
    // Calcular valor B2C
    let b2cValor = 0;
    b2cLocations.forEach(loc => {
      if (loc.packages) {
        loc.packages.forEach(pkg => {
          b2cValor += (pkg.qty || 0) * (pkg.cost || 0);
        });
      }
    });
    
    // B2C por marca
    const b2cPorMarca = {};
    b2cLocations.forEach(loc => {
      const marca = loc.brand || 'SIN_MARCA';
      if (!b2cPorMarca[marca]) {
        b2cPorMarca[marca] = { ocupadas: 0, total: 0, stock: 0 };
      }
      b2cPorMarca[marca].total++;
      if ((loc.totalStock || 0) > 0) b2cPorMarca[marca].ocupadas++;
      b2cPorMarca[marca].stock += (loc.totalStock || 0);
    });
    
    // Calcular porcentajes B2C por marca
    Object.keys(b2cPorMarca).forEach(m => {
      b2cPorMarca[m].porcentaje = b2cPorMarca[m].total > 0
        ? parseFloat((b2cPorMarca[m].ocupadas / b2cPorMarca[m].total * 100).toFixed(1))
        : 0;
    });
    
    // =========================================================================
    // FILTRAR B2B: Ubicaciones con "EXTB2B" excluyendo pasillos 22-29
    // =========================================================================
    const b2bLocations = locations.filter(loc => {
      const locId = loc.id || '';
      if (!locId.includes('EXTB2B')) return false;
      
      // Excluir pasillos 22-29
      const aisle = parseInt(loc.aisle, 10);
      if (!isNaN(aisle) && aisle >= 22 && aisle <= 29) return false;
      
      return true;
    });
    
    const b2bOcupadas = b2bLocations.filter(loc => (loc.totalStock || 0) > 0).length;
    const b2bTotal = b2bLocations.length;
    const b2bStock = b2bLocations.reduce((sum, loc) => sum + (loc.totalStock || 0), 0);
    const b2bPct = b2bTotal > 0 ? (b2bOcupadas / b2bTotal * 100) : 0;
    
    // Calcular valor B2B
    let b2bValor = 0;
    b2bLocations.forEach(loc => {
      if (loc.packages) {
        loc.packages.forEach(pkg => {
          b2bValor += (pkg.qty || 0) * (pkg.cost || 0);
        });
      }
    });
    
    // B2B por marca
    const b2bPorMarca = {};
    b2bLocations.forEach(loc => {
      const marca = loc.brand || 'SIN_MARCA';
      if (!b2bPorMarca[marca]) {
        b2bPorMarca[marca] = { ocupadas: 0, total: 0, stock: 0 };
      }
      b2bPorMarca[marca].total++;
      if ((loc.totalStock || 0) > 0) b2bPorMarca[marca].ocupadas++;
      b2bPorMarca[marca].stock += (loc.totalStock || 0);
    });
    
    // Calcular porcentajes B2B por marca
    Object.keys(b2bPorMarca).forEach(m => {
      b2bPorMarca[m].porcentaje = b2bPorMarca[m].total > 0
        ? parseFloat((b2bPorMarca[m].ocupadas / b2bPorMarca[m].total * 100).toFixed(1))
        : 0;
    });
    
    // =========================================================================
    // TOTAL REAL = B2C + B2B
    // =========================================================================
    const totalOcupadas = b2cOcupadas + b2bOcupadas;
    const totalUbicaciones = b2cTotal + b2bTotal;
    const totalStock = b2cStock + b2bStock;
    const totalValor = b2cValor + b2bValor;
    const totalPct = totalUbicaciones > 0 ? (totalOcupadas / totalUbicaciones * 100) : 0;
    
    // =========================================================================
    // RESPUESTA
    // =========================================================================
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      
      // Resumen total (B2C + B2B)
      resumen: {
        ocupacion_total_pct: parseFloat(totalPct.toFixed(1)),
        ubicaciones_ocupadas: totalOcupadas,
        ubicaciones_vacias: totalUbicaciones - totalOcupadas,
        ubicaciones_totales: totalUbicaciones,
        stock_total_unidades: totalStock,
        valor_total_eur: parseFloat(totalValor.toFixed(2))
      },
      
      // Desglose B2C
      b2c: {
        ocupacion_pct: parseFloat(b2cPct.toFixed(1)),
        ubicaciones_ocupadas: b2cOcupadas,
        ubicaciones_totales: b2cTotal,
        stock_unidades: b2cStock,
        valor_eur: parseFloat(b2cValor.toFixed(2)),
        por_marca: b2cPorMarca
      },
      
      // Desglose B2B
      b2b: {
        ocupacion_pct: parseFloat(b2bPct.toFixed(1)),
        ubicaciones_ocupadas: b2bOcupadas,
        ubicaciones_totales: b2bTotal,
        stock_unidades: b2bStock,
        valor_eur: parseFloat(b2bValor.toFixed(2)),
        por_marca: b2bPorMarca
      },
      
      // Por mercado (BLACK, GOLD, WHITE) - mantener compatibilidad
      // Ahora calculado desde B2C + B2B combinados
      por_mercado: {
        BLACK: {
          ocupadas: (b2cPorMarca.BLACK?.ocupadas || 0) + (b2bPorMarca.BLACK?.ocupadas || 0),
          total: (b2cPorMarca.BLACK?.total || 0) + (b2bPorMarca.BLACK?.total || 0),
          stock: (b2cPorMarca.BLACK?.stock || 0) + (b2bPorMarca.BLACK?.stock || 0),
          porcentaje: 0 // Se calcula abajo
        },
        GOLD: {
          ocupadas: (b2cPorMarca.GOLD?.ocupadas || 0) + (b2bPorMarca.GOLD?.ocupadas || 0),
          total: (b2cPorMarca.GOLD?.total || 0) + (b2bPorMarca.GOLD?.total || 0),
          stock: (b2cPorMarca.GOLD?.stock || 0) + (b2bPorMarca.GOLD?.stock || 0),
          porcentaje: 0
        },
        WHITE: {
          ocupadas: (b2cPorMarca.WHITE?.ocupadas || 0) + (b2bPorMarca.WHITE?.ocupadas || 0),
          total: (b2cPorMarca.WHITE?.total || 0) + (b2bPorMarca.WHITE?.total || 0),
          stock: (b2cPorMarca.WHITE?.stock || 0) + (b2bPorMarca.WHITE?.stock || 0),
          porcentaje: 0
        }
      }
    });
    
    // Calcular porcentajes por mercado
    const response = res._body ? JSON.parse(res._body) : null;
    
  } catch (error) {
    console.error('❌ [REPORTS] Error ocupación v2:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// También actualizar el endpoint original para que use la misma lógica
// O simplemente hacer que /api/reports/ocupacion redirija a /api/reports/ocupacion-v2
// --- SERVIDOR BASE ---
app.get("/api/locations", async (req, res) => {
  const dataPath = path.join(__dirname, "data", "locations.json");
  const raw = await fs.readFile(dataPath, "utf8");
  res.json(JSON.parse(raw));
});
app.get("/api/movements", (req, res) => res.json(movements.slice(0, 50)));
const server = createServer(app);
const wss = new WebSocketServer({ server });
function broadcastUpdate(data) { wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: "UPDATE_LOCATIONS", payload: data })); }); }
wss.on("connection", () => console.log("WS conectado"));
const POLLING_INTERVAL_MS = 5000;
let isSyncing = false;
setInterval(async () => {
  if (isSyncing) return;
  try { isSyncing = true; const updatedData = await syncWithOdoo(); if (updatedData) broadcastUpdate(updatedData); }
  catch (e) { console.error(e.message); } finally { isSyncing = false; }
}, POLLING_INTERVAL_MS);
server.listen(PORT, () => console.log(` 🚀  CEREBRO DEFINITIVO (Copilot + Math + Seasons) en ${PORT}`));