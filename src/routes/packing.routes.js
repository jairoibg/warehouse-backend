/**
 * Rutas para Packing List Analyzer
 */

import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getOpenAIClient } from '../services/aiService.js';
import { odooExecute, odooAuth } from '../services/odooService.js';

const execPromise = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Configuración de almacenamiento
const packingStorage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const packingUpload = multer({ storage: packingStorage, limits: { fileSize: 50 * 1024 * 1024 } });

if (!fsSync.existsSync('./uploads')) fsSync.mkdirSync('./uploads', { recursive: true });
if (!fsSync.existsSync('./packing-outputs')) fsSync.mkdirSync('./packing-outputs', { recursive: true });

// Cachés
let packingProductCache = new Map();
let packingAbcCache = new Map();
let packingStockCache = new Map();
let packingLastCacheUpdate = null;
let packingAnalysisCache = new Map();
let packingReferencesCache = new Map();

const CACHE_FILE_ANALYSIS = path.join(__dirname, '../../data', 'packing_analysis_cache.json');
const CACHE_FILE_REFERENCES = path.join(__dirname, '../../data', 'packing_references_cache.json');

// Normalización de colores
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

async function loadPackingCaches() {
  try {
    if (fsSync.existsSync(CACHE_FILE_ANALYSIS)) {
      const data = JSON.parse(await fs.readFile(CACHE_FILE_ANALYSIS, 'utf8'));
      packingAnalysisCache = new Map(Object.entries(data));
    }
    if (fsSync.existsSync(CACHE_FILE_REFERENCES)) {
      const data = JSON.parse(await fs.readFile(CACHE_FILE_REFERENCES, 'utf8'));
      packingReferencesCache = new Map(Object.entries(data));
    }
  } catch (err) {
    console.warn('⚠️ [CACHE] Error cargando cachés:', err.message);
  }
}

async function savePackingCaches() {
  try {
    await fs.mkdir(path.join(__dirname, '../../data'), { recursive: true });
    const analysisEntries = [...packingAnalysisCache.entries()].slice(-100);
    await fs.writeFile(CACHE_FILE_ANALYSIS, JSON.stringify(Object.fromEntries(analysisEntries), null, 2));
    const refEntries = [...packingReferencesCache.entries()].slice(-1000);
    await fs.writeFile(CACHE_FILE_REFERENCES, JSON.stringify(Object.fromEntries(refEntries), null, 2));
  } catch (err) {
    console.warn('⚠️ [CACHE] Error guardando:', err.message);
  }
}

async function calculatePDFHash(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  return crypto.createHash('md5').update(fileBuffer).digest('hex');
}

async function refreshPackingCache() {
  console.log('📦 [PACKING] Actualizando caché...');
  const startTime = Date.now();

  try {
    const uid = await odooAuth();

    const products = await odooExecute(
      'product.product',
      'search_read',
      [[['default_code', '!=', false], ['active', '=', true]]],
      { fields: ['id', 'default_code', 'name', 'standard_price'], limit: 50000 }
    );

    packingProductCache.clear();
    products.forEach(p => {
      if (p.default_code) {
        packingProductCache.set(p.default_code.toUpperCase().trim(), {
          id: p.id, name: p.name, code: p.default_code, cost: p.standard_price || 0
        });
      }
    });

    try {
      const abcData = await odooExecute(
        'abc.classification.product.level',
        'search_read',
        [[]],
        { fields: ['product_id', 'level_id'], limit: 100000 }
      );
      packingAbcCache.clear();
      abcData.forEach(row => {
        if (row.product_id && row.level_id) {
          packingAbcCache.set(row.product_id[0], (row.level_id[1] || 'D').charAt(0).toUpperCase());
        }
      });
    } catch (e) {
      console.log(`    ⚠️ No se pudo cargar ABC: ${e.message}`);
    }

    const quants = await odooExecute(
      'stock.quant',
      'search_read',
      [[['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]],
      { fields: ['product_id', 'location_id', 'quantity'], limit: 100000 }
    );

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

    packingLastCacheUpdate = new Date();
    console.log(`✅ [PACKING] Caché actualizada en ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);
    return { products: packingProductCache.size, abc: packingAbcCache.size, stock: packingStockCache.size };
  } catch (error) {
    console.error('❌ [PACKING] Error actualizando caché:', error.message);
    throw error;
  }
}

async function parsePackingPDFWithAI(filePath) {
  console.log('🧠 [PACKING-AI v3.3] Iniciando análisis con Claude Opus 4.5...');
  const tempScriptPath = path.join(__dirname, '../../temp_extractor.py');
  const absolutePath = path.resolve(filePath);
  
  const pythonScript = `
import pdfplumber
import json
import sys
import re
import io

# Configurar UTF-8 para stdout en Windows
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

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
    output = json.dumps(result, ensure_ascii=False)
    print(output)
except Exception as e:
    error_msg = json.dumps({"error": str(e)})
    print(error_msg)
    sys.exit(1)
`;

  try {
    await fs.writeFile(tempScriptPath, pythonScript, 'utf8');
    const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
    
    let extracted;
    try {
      // Configurar UTF-8 para Python en Windows
      const execOptions = { 
        maxBuffer: 100 * 1024 * 1024,
        timeout: 30000,
        encoding: 'utf8'
      };
      
      // En Windows, establecer PYTHONIOENCODING
      if (process.platform === 'win32') {
        execOptions.env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
      }
      
      const { stdout, stderr } = await execPromise(`"${pythonExe}" "${tempScriptPath}" "${absolutePath}"`, execOptions);
      
      if (stderr && !stdout) {
        console.warn('⚠️ [PACKING] Python stderr:', stderr);
        throw new Error(`Error ejecutando Python: ${stderr}`);
      }
      
      if (!stdout || stdout.trim() === '') {
        throw new Error('No se pudo extraer contenido del PDF - salida vacía');
      }
      
      extracted = JSON.parse(stdout);
      if (extracted.error) {
        throw new Error(`Error en extracción Python: ${extracted.error}`);
      }
    } catch (execError) {
      console.error('❌ [PACKING] Error ejecutando Python:', execError.message);
      // Intentar sin Python como fallback - usar solo el texto crudo si está disponible
      throw new Error(`Error procesando PDF con Python: ${execError.message}. Verifica que Python y pdfplumber estén instalados.`);
    } finally {
      await fs.unlink(tempScriptPath).catch(() => {});
    }

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

    const openai = getOpenAIClient();
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 16384,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { 
          role: "system", 
          content: `Eres un experto en logística de almacén especializado en analizar packing lists de contenedores marítimos.

INSTRUCCIONES:
1. Extrae CADA LÍNEA del documento como un item separado
2. Para cada línea, extrae:
   - reference: El código de referencia (REF), siempre en MAYÚSCULAS
   - quantity: La cantidad en unidades (puede venir como "650 PCS", "1200 PCS", etc. - extrae solo el número)
   - productName: La descripción del producto (campo Descriptions)
   - lineNumber: El número de línea si está disponible

3. El formato de respuesta debe ser JSON estricto con esta estructura:
{
  "container_number": "CAAU9872370" o el número de contenedor detectado,
  "items": [
    {
      "reference": "DFKSUN0245-0804",
      "quantity": 650,
      "productName": "Jackson square Demi/G15",
      "lineNumber": 1
    },
    ...
  ]
}

IMPORTANTE:
- Todas las referencias deben estar en MAYÚSCULAS
- Las cantidades deben ser números enteros (sin "PCS", sin espacios)
- Extrae TODAS las líneas, no omitas ninguna
- Si una línea no tiene referencia o cantidad válida, omítela del array`
        },
        { 
          role: "user", 
          content: `Analiza este packing list y extrae TODAS las líneas de productos. Asegúrate de incluir TODAS las referencias y cantidades:

${contentForAI}

Responde SOLO con el JSON, sin texto adicional antes o después.` 
        }
      ]
    });

    // Obtener la respuesta directamente (con JSON mode no se usa streaming)
    const aiText = aiResponse.choices[0]?.message?.content || '';
    
    let parsedAI;
    try {
      // Intentar parsear directamente
      parsedAI = JSON.parse(aiText.trim());
    } catch (e) {
      // Si falla, buscar JSON en el texto
      try {
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedAI = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('No se encontró JSON válido en la respuesta de AI');
        }
      } catch (parseError) {
        console.error('❌ [PACKING] Error parseando respuesta AI:', parseError.message);
        console.error('Respuesta AI recibida:', aiText.substring(0, 500));
        parsedAI = { items: [], confidence: "LOW", error: `Error parseando respuesta: ${parseError.message}` };
      }
    }
    
    // Validar estructura básica
    if (!parsedAI.items || !Array.isArray(parsedAI.items)) {
      console.warn('⚠️ [PACKING] Respuesta AI no tiene items válidos, inicializando array vacío');
      parsedAI.items = parsedAI.items || [];
    }
    
    if (!parsedAI.container_number && extracted.container_candidates.length > 0) {
      parsedAI.container_number = extracted.container_candidates[0];
    }

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
    
    return parsedAI;
  } catch (error) {
    await fs.unlink(tempScriptPath).catch(() => {});
    throw error;
  }
}

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

  function getPackingRules(reference, minSize, productType) {
    const ref = (reference || '').toUpperCase();
    if (productType === 'SUNGLASSES' || ref.startsWith('DFKSUN') || ref.startsWith('DFSU')) {
      return { udsPerBox: 50, boxesPerPallet: 22, type: 'SUNGLASSES' };
    }
    if (productType === 'SOCKS' || ref.includes('DFTXSOCO') || ref.includes('SOC')) {
      return { udsPerBox: 50, boxesPerPallet: 50, type: 'SOCKS' };
    }
    const size = minSize || 36;
    if (size < 36) return { udsPerBox: null, boxesPerPallet: 28, type: 'FOOTWEAR_KIDS' };
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
      if (key.includes(baseCode) || key.includes(reference.replace(/-/g, ''))) return value;
    }
    return null;
  }

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
    let abcClass = 'NEW', currentStock = 0, stockLocations = [];
    
    if (productInfo) {
      abcClass = packingAbcCache.get(productInfo.id) || 'D';
      const stock = packingStockCache.get(productInfo.id);
      if (stock) { 
        currentStock = stock.total; 
        stockLocations = (stock.locations || []).map(loc => ({
          location: loc.name || 'Desconocida', qty: loc.qty || 0
        })).filter(loc => loc.qty > 0);
      }
    }

    if (!groupedTotals.has(reference)) {
      groupedTotals.set(reference, { 
        reference, totalUnits: 0, totalBoxes: 0, 
        productName: productInfo?.name || item.productName || 'No encontrado',
        abcClass, currentStock, stockLocations,
        productType: rules.type, boxesPerPallet: rules.boxesPerPallet, lines: 0
      });
    }
    const grouped = groupedTotals.get(reference);
    grouped.totalUnits += item.quantity || 0;
    grouped.totalBoxes += totalBoxes;
    grouped.lines++;

    const qty = item.quantity || 0;
    summary.byABC[abcClass] = (summary.byABC[abcClass] || 0) + qty;
    summary.byType[rules.type] = (summary.byType[rules.type] || 0) + qty;
    summary.totalUnits += qty;
    summary.totalBoxes += totalBoxes;
    summary.totalPallets += totalPallets;

    enriched.push({
      lineNumber: item.lineNumber || index + 1, itemNo: reference,
      productName: productInfo?.name || item.productName || 'No encontrado en Odoo',
      sizeRange: item.sizeRange || '-', prsPerCtn: item.prsPerCtn || '-',
      totalUnits: qty, totalBoxes, totalPallets: Math.round(totalPallets * 100) / 100,
      productType: rules.type, boxesPerPallet: rules.boxesPerPallet,
      abcClass, currentStock, stockLocations: stockLocations.slice(0, 5)
    });
  });

  groupedTotals.forEach((data, reference) => {
    const pallets = data.totalBoxes / data.boxesPerPallet;
    summary.groupedTotals.push({
      reference: data.reference, productName: data.productName,
      totalUnits: data.totalUnits, totalBoxes: data.totalBoxes,
      totalPallets: Math.round(pallets * 100) / 100, lines: data.lines,
      abcClass: data.abcClass, currentStock: data.currentStock, stockLocations: data.stockLocations
    });
    if (data.currentStock > 0) {
      const locNames = data.stockLocations.slice(0, 3).map(l => l.location).join(', ');
      summary.consolidationAlerts.push({ 
        itemNo: reference, currentStock: data.currentStock, incomingUnits: data.totalUnits,
        message: `⚠️ Stock: ${data.currentStock} uds en ${data.stockLocations.length} ubic. (${locNames})`
      });
    }
    if (data.abcClass === 'NEW') summary.newReferences.push(reference);
  });

  summary.totalPallets = Math.round(summary.totalPallets * 100) / 100;
  enriched.sort((a, b) => a.itemNo !== b.itemNo ? a.itemNo.localeCompare(b.itemNo) : a.lineNumber - b.lineNumber);

  return { items: enriched, summary };
}

// Cargar cachés al iniciar
loadPackingCaches();

/**
 * GET /api/packing/health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok', version: '3.3-OPUS-CACHE',
    cache: { 
      odoo: { products: packingProductCache.size, abc: packingAbcCache.size, stock: packingStockCache.size, lastUpdate: packingLastCacheUpdate },
      analysis: { count: packingAnalysisCache.size, maxSize: 100 },
      references: { count: packingReferencesCache.size, maxSize: 1000 }
    }
  });
});

/**
 * GET /api/packing/cache/stats
 */
router.get('/cache/stats', (req, res) => {
  res.json({
    analysis: {
      count: packingAnalysisCache.size,
      containers: [...packingAnalysisCache.values()].map(v => ({
        container: v.containerNumber, fileName: v.fileName, items: v.items?.length || 0, date: v.analyzedAt
      }))
    },
    references: {
      count: packingReferencesCache.size,
      sample: [...packingReferencesCache.entries()].slice(0, 20).map(([ref, data]) => ({
        reference: ref, type: data.productType, seenCount: data.seenCount
      }))
    }
  });
});

/**
 * DELETE /api/packing/cache/clear
 */
router.delete('/cache/clear', asyncHandler(async (req, res) => {
  const what = req.query.what || 'all';
  if (what === 'all' || what === 'analysis') {
    packingAnalysisCache.clear();
    await fs.unlink(CACHE_FILE_ANALYSIS).catch(() => {});
  }
  if (what === 'all' || what === 'references') {
    packingReferencesCache.clear();
    await fs.unlink(CACHE_FILE_REFERENCES).catch(() => {});
  }
  res.json({ success: true, message: `Caché ${what} limpiado` });
}));

/**
 * POST /api/packing/cache/refresh
 */
router.post('/cache/refresh', asyncHandler(async (req, res) => {
  const stats = await refreshPackingCache();
  res.json({ success: true, stats });
}));

/**
 * POST /api/packing/analyze
 */
router.post('/analyze', packingUpload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  
  const forceReanalyze = req.query.force === 'true';
  console.log(`\n📄 [PACKING v3.3] Analizando: ${req.file.originalname}${forceReanalyze ? ' (FORZADO)' : ''}`);

  const pdfHash = await calculatePDFHash(req.file.path);

  if (!forceReanalyze && packingAnalysisCache.has(pdfHash)) {
    const cached = packingAnalysisCache.get(pdfHash);
    await fs.unlink(req.file.path).catch(() => {});
    return res.json({ ...cached, fromCache: true, cacheDate: cached.analyzedAt });
  }

  if (!packingLastCacheUpdate || (Date.now() - packingLastCacheUpdate.getTime()) > 3600000) {
    try { await refreshPackingCache(); } catch (e) { console.warn('⚠️ Cache Odoo no actualizada'); }
  }

  const parsed = await parsePackingPDFWithAI(req.file.path);
  const containerNumber = parsed.container_number || req.file.originalname.match(/[A-Z]{4}\d{7}/)?.[0] || 'UNKNOWN';
  const enriched = enrichPackingListAI(parsed);

  const result = {
    success: true, containerNumber, summary: enriched.summary, items: enriched.items,
    groupedTotals: enriched.summary.groupedTotals, aiPowered: true, model: 'opus-4.5',
    analyzedAt: new Date().toISOString(), fileName: req.file.originalname
  };
  
  packingAnalysisCache.set(pdfHash, result);
  savePackingCaches().catch(err => console.warn('Error guardando caché:', err));

  await fs.unlink(req.file.path).catch(() => {});
  console.log(`✅ [PACKING] Completado: ${enriched.items.length} líneas (guardado en caché)\n`);

  res.json({ ...result, fromCache: false });
}));

/**
 * GET /api/packing/download/:filename
 */
router.get('/download/:filename', (req, res) => {
  res.download(path.join(__dirname, '../../packing-outputs', req.params.filename));
});

export default router;



