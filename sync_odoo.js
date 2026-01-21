import xmlrpc from 'xmlrpc';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { explanationEngine } from './explanation_engine.js';

// --- CONFIGURACIÓN ODOO (SEGURA) ---
const ODOO_CONFIG = {
  url: 'https://blackdivision.processcontrol.sh',
  db: 'blackdivision',
  username: 'j.bernabe@illice.com',
  password: '98b68f64a4ee2fd5362f16f3b0427a629877f80f',
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCATIONS_FILE = path.join(__dirname, 'data', 'locations.json');

// ==================================================================================
//  MÓDULO DE INGENIERÍA LOGÍSTICA (CÁLCULO VOLUMÉTRICO)
// ==================================================================================
const PALLET = { L: 120, W: 80, H: 180 };
const BOX_RULES = {
  'GAFAS': { l: 58.3, w: 38.3, h: 34, desc: 'Caja Gafas (DF)', isVolumetric: true },
  'STANDARD': { l: 0, w: 0, h: 0, desc: 'Estándar', isVolumetric: false }
};

function optimizeLayer(PL, PW, cl, cw) {
  if (Math.min(PL, PW) < Math.min(cl, cw)) return 0;
  const countA = Math.floor(PL / cl) * Math.floor(PW / cw);
  const countB = Math.floor(PL / cw) * Math.floor(PW / cl);
  let countC = 0;
  if (PL >= cw) {
    const stripCount = Math.floor(PL / cw);
    const remainingW = PW - cl;
    if (remainingW >= Math.min(cl, cw)) {
        countC = stripCount + optimizeLayer(PL, remainingW, cl, cw);
    }
  }
  return Math.max(countA, countB, countC);
}

function getPalletCapacity(boxRule) {
  if (!boxRule.isVolumetric) return 0;
  const layers = Math.floor(PALLET.H / boxRule.h);
  if (layers === 0) return 0;
  const boxesPerLayer = optimizeLayer(PALLET.L, PALLET.W, boxRule.l, boxRule.w);
  return layers * boxesPerLayer;
}

function getBoxRule(ref) {
  if (!ref) return BOX_RULES['STANDARD'];
  const r = ref.toUpperCase();
  if (r.includes("DFKSUN") || r.includes("DFSU")) return BOX_RULES['GAFAS'];
  return BOX_RULES['STANDARD'];
}

// ==================================================================================
//  HELPERS - MODIFICADOS PARA B2C + B2B
// ==================================================================================

/**
 * Extrae el ID de ubicación normalizado de un nombre completo de Odoo.
 * Soporta tanto B2C (Storage) como B2B (EXTB2B).
 * 
 * Ejemplos:
 *   - B2C: "CLABD/Stock/StorageBD/CLA-004-01-01-01" → "CLA-004-01-01-01"
 *   - B2B: "CLABD/Stock/EXTB2BBD/CLA-001-03-02-03" → "CLA-001-03-02-03"
 */
function findLocationID(fullName) {
  if (!fullName) return "UNKNOWN";
  
  // El regex CLA-XXX-XX-XX-XX funciona igual para B2C y B2B
  const match = fullName.match(/CLA-\d{3}-\d{2}-\d{2}-\d{2}/);
  if (match) return match[0];
  
  // Fallback: último segmento
  const parts = fullName.split('/');
  return parts[parts.length - 1].trim();
}

/**
 * Determina el tipo de almacén (B2C, B2B o PLAYA) desde el nombre completo de Odoo.
 */
function getWarehouseType(fullName) {
  if (!fullName) return "UNKNOWN";
  // Playa debe ir primero porque contiene "B2C" o "B2B" en el nombre
  if (fullName.includes('Playa')) {
    if (fullName.includes('PlayaB2B')) return "PLAYA_B2B";
    if (fullName.includes('PlayaB2C')) return "PLAYA_B2C";
    return "PLAYA";
  }
  if (fullName.includes('EXTB2B')) return "B2B";
  if (fullName.includes('Storage')) return "B2C";
  return "OTHER";
}

/**
 * Construye la clave única para hacer match entre Odoo y locations.json.
 * Incluye el tipo de almacén para evitar colisiones entre B2C y B2B
 * que podrían tener el mismo código CLA-XXX-XX-XX-XX.
 */
function buildLocationKey(fullName) {
  const locId = findLocationID(fullName);
  const whType = getWarehouseType(fullName);
  
  // Extraer el sufijo de marca (BD, GD, WD)
  let brandSuffix = '';
  if (fullName.includes('BD')) brandSuffix = 'BD';
  else if (fullName.includes('GD')) brandSuffix = 'GD';
  else if (fullName.includes('WD') || fullName.includes('WH')) brandSuffix = 'WD';
  
  return `${whType}:${brandSuffix}:${locId}`;
}

/**
 * Extrae la clave desde un ID de locations.json
 */
function extractKeyFromLocationId(locationId) {
  const locId = findLocationID(locationId);
  const whType = getWarehouseType(locationId);
  
  let brandSuffix = '';
  if (locationId.includes('BD')) brandSuffix = 'BD';
  else if (locationId.includes('GD')) brandSuffix = 'GD';
  else if (locationId.includes('WD') || locationId.includes('WH')) brandSuffix = 'WD';
  
  return `${whType}:${brandSuffix}:${locId}`;
}

function calculateDaysOld(dateString) {
  if (!dateString) return 0;
  const entryDate = new Date(dateString);
  const today = new Date();
  return Math.ceil(Math.abs(today.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24));
}

// --- Detección de Marca ---
function detectBrandFromItem(pkgName, productCode) {
    const searchStr = `${pkgName || ""} ${productCode || ""}`.toUpperCase();
    if (searchStr.startsWith('DF') || searchStr.includes('IBGB') || searchStr.includes('BLACK')) return 'BLACK';
    if (searchStr.startsWith('KA') || searchStr.startsWith('KL') || searchStr.includes('IBGW') || searchStr.includes('WHITE')) return 'WHITE';
    if (
        searchStr.startsWith('CO') || searchStr.includes('IBGG') || searchStr.includes('GOLD') || 
        searchStr.startsWith('BW') || searchStr.startsWith('BJ') || 
        searchStr.startsWith('OS') || searchStr.startsWith('TE')
    ) return 'GOLD';
    return 'GENERIC';
}

// ==================================================================================
//  FUNCIÓN CRÍTICA: EXTRAER LETRA ABC DE ODOO
// ==================================================================================
/**
 * Extrae la letra de clasificación ABC del string completo de Odoo.
 * 
 * Odoo devuelve el level_id[1] con formatos como:
 *   - "ABC (CLA - Black): A"
 *   - "ABC Gafas: A"
 *   - "ABC (CLA - Black): B"
 *   - "A" (en algunos casos)
 * 
 * Esta función extrae SOLO la letra A, B, C o D.
 * 
 * @param {string|null} levelString - El string completo de Odoo
 * @returns {string} - La letra de clasificación (A, B, C o D)
 */
function extractABCLetter(levelString) {
  if (!levelString) return "D";
  
  const str = String(levelString).trim().toUpperCase();
  
  // Caso 1: Ya es solo una letra (A, B, C, D)
  if (/^[ABCD]$/.test(str)) {
    return str;
  }
  
  // Caso 2: Formato "ABC (CLA - Black): A" o "ABC Gafas: A"
  // Buscar ": A" o ": B" etc al final del string
  const colonMatch = str.match(/:\s*([ABCD])\s*$/);
  if (colonMatch) {
    return colonMatch[1];
  }
  
  // Caso 3: Buscar la última letra A, B, C o D en el string
  // Esto maneja casos edge como "ABC Classification Level A"
  const lastLetterMatch = str.match(/[ABCD](?=[^ABCD]*$)/);
  if (lastLetterMatch) {
    return lastLetterMatch[0];
  }
  
  // Caso 4: Si no encontramos nada válido, devolver D (por defecto)
  console.log(`  ⚠️  [ABC] No se pudo extraer letra de: "${levelString}" → usando "D"`);
  return "D";
}

// ==================================================================================
//  CONECTORES ODOO
// ==================================================================================
function odooAuth() {
  return new Promise((resolve, reject) => {
    const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
    common.methodCall('authenticate', [
      ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
    ], (error, uid) => {
      if (error) return reject(error);
      if (!uid) return reject(new Error("Autenticación fallida. Revisa .env"));
      resolve(uid);
    });
  });
}

function fetchBatchStock(uid, offset, limit) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    const fields = ['location_id', 'package_id', 'product_id', 'quantity', 'reserved_quantity', 'in_date', 'product_set_id'];
    const domain = [['location_id.usage', '=', 'internal']];
    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
      'stock.quant', 'search_read', [domain],
      { fields: fields, offset: offset, limit: limit }
    ], (error, result) => {
      if (error) return reject(error);
      
      // REGISTRO DE EXPLICABILIDAD
      const executionTime = Date.now() - startTime;
      explanationEngine.registerOdooQuery(
        'stock.quant.search_read',
        { offset, limit, domain },
        result,
        executionTime
      );
      
      resolve(result);
    });
  });
}

function fetchProductDetails(uid, productIds) {
  return new Promise((resolve, reject) => {
    if (productIds.length === 0) return resolve([]);
    const startTime = Date.now();
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    const fields = ['name', 'default_code', 'standard_price', 'sale_season_id']; 
    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
      'product.product', 'read', [productIds],
      { fields: fields }
    ], (error, products) => {
      if (error) return reject(error);
      
      // REGISTRO DE EXPLICABILIDAD
      const executionTime = Date.now() - startTime;
      explanationEngine.registerOdooQuery(
        'product.product.read',
        { productIds: productIds.slice(0, 10), count: productIds.length },
        products,
        executionTime
      );
      
      resolve(products);
    });
  });
}

function fetchABCData(uid, productIds) {
  return new Promise((resolve, reject) => {
    if (productIds.length === 0) return resolve([]);
    const startTime = Date.now();
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
      'abc.classification.product.level', 'search_read', 
      [[['product_id', 'in', productIds]]],
      { fields: ['product_id', 'level_id'] }
    ], (error, results) => {
      if (error) { 
        console.error(" ❌  Error ABC:", error); 
        resolve([]); 
      } else {
        // REGISTRO DE EXPLICABILIDAD
        const executionTime = Date.now() - startTime;
        explanationEngine.registerOdooQuery(
          'abc.classification.product.level.search_read',
          { productIds: productIds.slice(0, 10), count: productIds.length },
          results,
          executionTime
        );
        
        resolve(results);
      }
    });
  });
}

// --- MOTOR DE AUTO-CLASIFICACIÓN DE HUÉRFANOS (MACD) ---
async function calculateOrphanABC(uid, orphanIds) {
    if (orphanIds.length === 0) return {};

    console.log(` 🚑  [MACD] Calculando ABC para ${orphanIds.length} productos huérfanos...`);
    
    const date = new Date();
    date.setDate(date.getDate() - 30);
    const dateStr = date.toISOString().split('T')[0];

    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    
    try {
        const startTime = Date.now();
        const sales = await new Promise((resolve, reject) => {
            models.methodCall('execute_kw', [
                ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
                'sale.order.line', 'search_read', 
                [[['product_id', 'in', orphanIds], ['order_id.date_order', '>=', dateStr], ['state', 'in', ['sale', 'done']]]],
                { fields: ['product_id', 'price_total'] }
            ], (err, res) => err ? reject(err) : resolve(res));
        });

        const executionTime = Date.now() - startTime;
        explanationEngine.registerOdooQuery(
          'sale.order.line.search_read.macd',
          { orphanIds: orphanIds.slice(0, 10), count: orphanIds.length, dateFrom: dateStr },
          sales,
          executionTime
        );

        const salesMap = {};
        let totalRevenue = 0;
        
        sales.forEach(s => {
            const pid = s.product_id[0];
            const val = s.price_total || 0;
            salesMap[pid] = (salesMap[pid] || 0) + val;
            totalRevenue += val;
        });

        const rankedProducts = orphanIds.map(id => ({
            id: id,
            value: salesMap[id] || 0
        })).sort((a, b) => b.value - a.value);

        const calculatedABC = {};
        let currentSum = 0;

        rankedProducts.forEach(p => {
            if (p.value === 0) {
                calculatedABC[p.id] = "D";
            } else {
                currentSum += p.value;
                const percentage = (currentSum / totalRevenue) * 100;

                if (percentage <= 80) calculatedABC[p.id] = "A";
                else if (percentage <= 95) calculatedABC[p.id] = "B";
                else calculatedABC[p.id] = "C";
            }
        });

        explanationEngine.registerDecision(
          'macd_abc_classification',
          { orphanCount: orphanIds.length, totalRevenue },
          calculatedABC,
          {
            algorithm: 'Pareto 80/15/5',
            dataSource: 'sale.order.line últimos 30 días',
            confidence: 'MEDIUM'
          }
        );

        console.log(" ✅  [MACD] Clasificación completada.");
        return calculatedABC;

    } catch (e) {
        console.error("Error en Auto-Clasificación:", e);
        return {};
    }
}

// BI: Ventas Reales (Exportada)
export async function getRealTimeSales(daysBack) {
  try {
    const uid = await odooAuth();
    const date = new Date(); date.setDate(date.getDate() - daysBack);
    const dateStr = date.toISOString().split('T')[0];
    console.log(` 📉  [ODOO LIVE] Descargando ventas desde ${dateStr}...`);
    const startTime = Date.now();
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    const domain = [['order_id.date_order', '>=', dateStr], ['state', 'in', ['sale', 'done']]];
    return new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
        'sale.order.line', 'search_read', [domain],
        { fields: ['product_id', 'product_uom_qty', 'price_total'] } 
      ], (error, results) => {
        if (error) return reject(error);
        
        const executionTime = Date.now() - startTime;
        explanationEngine.registerOdooQuery(
          'sale.order.line.search_read.sales',
          { daysBack, dateFrom: dateStr },
          results,
          executionTime
        );
        
        const cleanData = results.filter(r => {
            const name = (r.product_id && r.product_id[1]) ? r.product_id[1].toUpperCase() : "";
            return !["OUTVIO", "TRANSPORT", "SHIPPING", "ENVIO", "DISCOUNT"].some(x => name.includes(x));
        }).map(r => ({ p: r.product_id[1], q: r.product_uom_qty, v: r.price_total }));
        resolve(cleanData);
      });
    });
  } catch (e) { return []; }
}

// Velocidad Interna (90 días)
function fetchSalesVelocity(uid, productIds) {
  return new Promise((resolve, reject) => {
    if (productIds.length === 0) return resolve({});
    const date = new Date(); date.setDate(date.getDate() - 90);
    const dateStr = date.toISOString().split('T')[0];
    const startTime = Date.now();
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
      'sale.order.line', 'search_read', 
      [[['product_id', 'in', productIds], ['order_id.date_order', '>=', dateStr], ['state', 'in', ['sale', 'done']]]],
      { fields: ['product_id', 'product_uom_qty'] } 
    ], (error, results) => {
      if (error) { resolve({}); return; }
      
      const executionTime = Date.now() - startTime;
      explanationEngine.registerOdooQuery(
        'sale.order.line.search_read.velocity',
        { productIds: productIds.slice(0, 10), count: productIds.length, dateFrom: dateStr },
        results,
        executionTime
      );
      
      const salesMap = {};
      results.forEach(line => {
        const pid = line.product_id[0];
        const qty = line.product_uom_qty || 0;
        if (!salesMap[pid]) salesMap[pid] = 0;
        salesMap[pid] += qty;
      });
      const velocityMap = {};
      for (const [pid, total] of Object.entries(salesMap)) {
        velocityMap[pid] = parseFloat((total / 90).toFixed(4));
      }
      resolve(velocityMap);
    });
  });
}

async function fetchAllStock(uid) {
  let allQuants = [];
  let offset = 0;
  const BATCH_SIZE = 5000;
  let keepFetching = true;
  console.log(" ⏳  Iniciando descarga de stock (B2C + B2B)...");
  while (keepFetching) {
    try {
      const batch = await fetchBatchStock(uid, offset, BATCH_SIZE);
      allQuants = allQuants.concat(batch);
      offset += BATCH_SIZE;
      process.stdout.write(`\r   ... ${allQuants.length} líneas bajadas`);
      if (batch.length < BATCH_SIZE) keepFetching = false;
    } catch (err) {
      console.error("\n ❌  Error en lote:", err);
      keepFetching = false;
    }
  }
  console.log("\n 📦  Stock descargado.");
  return allQuants;
}

// ==================================================================================
//  ORQUESTADOR PRINCIPAL - MODIFICADO PARA B2C + B2B + FIX ABC
// ==================================================================================
export async function syncWithOdoo() {
  try {
    const rawData = await fs.readFile(LOCATIONS_FILE, 'utf-8');
    let locations = JSON.parse(rawData);
    const uid = await odooAuth();

    // Estadísticas por tipo de almacén
    const b2cCount = locations.filter(l => l.id.includes('Storage')).length;
    const b2bCount = locations.filter(l => l.id.includes('EXTB2B')).length;
    const playaCount = locations.filter(l => l.id.includes('Playa')).length;
    console.log(` 📊  Ubicaciones en JSON: ${locations.length} (B2C: ${b2cCount}, B2B: ${b2bCount}, Playa: ${playaCount})`);

    const stockData = await fetchAllStock(uid);
    
    // Estadísticas del stock descargado
    const stockB2C = stockData.filter(q => q.location_id && q.location_id[1].includes('Storage')).length;
    const stockB2B = stockData.filter(q => q.location_id && q.location_id[1].includes('EXTB2B')).length;
    const stockPlaya = stockData.filter(q => q.location_id && q.location_id[1].includes('Playa') && !q.location_id[1].includes('SalvaStock')).length;
    console.log(` 📊  Stock Odoo: ${stockData.length} quants (B2C: ${stockB2C}, B2B: ${stockB2B}, Playa: ${stockPlaya})`);

    const productIds = [...new Set(stockData.map(q => q.product_id[0]))];
    
    console.log(` 🧬  Cruzando datos para ${productIds.length} productos...`);
    
    const [productsInfo, abcData, velocityMap] = await Promise.all([
        fetchProductDetails(uid, productIds),
        fetchABCData(uid, productIds),
        fetchSalesVelocity(uid, productIds)
    ]);

    // ==================================================================================
    //  LÓGICA HÍBRIDA DE CLASIFICACIÓN ABC - CORREGIDA
    // ==================================================================================
    const abcMap = {};
    const foundIds = new Set();
    
    // Estadísticas para verificación
    let abcStats = { A: 0, B: 0, C: 0, D: 0, total: 0, rawExamples: [] };
    
    abcData.forEach(row => {
      const pid = row.product_id[0];
      foundIds.add(pid);
      
      // *** CORRECCIÓN CRÍTICA ***
      // Antes: const letter = row.level_id ? row.level_id[1] : "D";
      // Esto guardaba "ABC (CLA - Black): A" en vez de solo "A"
      
      const rawLevel = row.level_id ? row.level_id[1] : null;
      const letter = extractABCLetter(rawLevel);  // ← AHORA extrae solo la letra
      
      // Guardar ejemplos para debug (solo los primeros 5)
      if (abcStats.rawExamples.length < 5) {
        abcStats.rawExamples.push({ raw: rawLevel, extracted: letter });
      }
      
      abcStats.total++;
      abcStats[letter]++;
      
      // Si el producto ya tiene clasificación, quedarse con la mejor (A > B > C > D)
      const current = abcMap[pid];
      if (!current || letter < current) {
        abcMap[pid] = letter;
      }
    });
    
    // Log de verificación
    console.log(` 📊  ABC extraído de Odoo: A=${abcStats.A}, B=${abcStats.B}, C=${abcStats.C}, D=${abcStats.D} (total: ${abcStats.total})`);
    if (abcStats.rawExamples.length > 0) {
      console.log(`     Ejemplos de extracción:`);
      abcStats.rawExamples.forEach(ex => {
        console.log(`       "${ex.raw}" → "${ex.extracted}"`);
      });
    }
    // ==================================================================================

    // Detectar productos huérfanos (sin clasificación en Odoo)
    const orphanIds = productIds.filter(id => !foundIds.has(id));
    console.log(` 🔍  Productos sin ABC en Odoo: ${orphanIds.length}`);
    
    // Calcular ABC para huérfanos usando MACD
    let calculatedABC = {};
    if (orphanIds.length > 0) {
        calculatedABC = await calculateOrphanABC(uid, orphanIds);
    }

    // --- MAPEO FINAL ---
    const productMeta = {};
    productsInfo.forEach(p => {
      const ref = p.default_code || "";
      const boxRule = getBoxRule(ref);
      
      let seasonReal = "N/A";
      if (p.sale_season_id && Array.isArray(p.sale_season_id)) {
          const rawName = p.sale_season_id[1].trim().toUpperCase();
          if (/^[IV]\d{2}$/.test(rawName)) seasonReal = rawName;
          else seasonReal = "N/A"; 
      }

      const palletCap = getPalletCapacity(boxRule);
      let occupancyPerBox = boxRule.isVolumetric ? (palletCap > 0 ? (100 / palletCap) : 100) : 10;
      
      // Prioridad: Odoo oficial > MACD calculado > Default "D"
      const finalABC = abcMap[p.id] || calculatedABC[p.id] || "D";

      productMeta[p.id] = {
        abcClass: finalABC,
        velocity: velocityMap[p.id] || 0,
        cost: p.standard_price || 0,
        name: p.name || "",
        code: ref,
        season: seasonReal,
        occupancyPerBox: occupancyPerBox
      };
    });

    // --- AGRUPAR STOCK POR CLAVE ÚNICA (tipo:marca:locId) ---
    const contentByKey = {};
    stockData.forEach(quant => {
      if (!quant.location_id) return;
      
      const fullName = quant.location_id[1];
      const key = buildLocationKey(fullName);
      
      if (!contentByKey[key]) contentByKey[key] = [];
      
      const pid = quant.product_id[0];
      const meta = productMeta[pid] || { abcClass: "D", velocity: 0, cost: 0, name: "", code: "", season: "N/A", occupancyPerBox: 10 };

      let surtidoReal = "";
      if (quant.product_set_id) {
        surtidoReal = Array.isArray(quant.product_set_id) ? quant.product_set_id[1] : quant.product_set_id;
      } else {
        surtidoReal = quant.product_id[1] || meta.name || "Sin Surtido";
      }

      contentByKey[key].push({
        packageId: quant.package_id ? quant.package_id[1] : "SIN_PAQUETE",
        productCode: meta.code || "SIN_REF",
        surtido: surtidoReal,
        qty: quant.quantity,
        reservedQty: quant.reserved_quantity,
        abcClass: meta.abcClass,
        velocity: meta.velocity,
        cost: meta.cost,
        season: meta.season,
        daysOld: calculateDaysOld(quant.in_date),
        occupancyVal: meta.occupancyPerBox
      });
    });

    // --- ACTUALIZAR UBICACIONES ---
    let matchesB2C = 0;
    let matchesB2B = 0;
    let matchesPlaya = 0;
    
    // --- GENERAR UBICACIONES DE PLAYA DINÁMICAMENTE ---
    const playaLocations = [
      { id: "CLABD/Stock/PlayaB2C", brand: "BLACK", market: "B2C", type: "PLAYA" },
      { id: "CLABD/Stock/PlayaB2B", brand: "BLACK", market: "B2B", type: "PLAYA" },
      { id: "CLAGD/Stock/PlayaB2C", brand: "GOLD", market: "B2C", type: "PLAYA" },
      { id: "CLAGD/Stock/PlayaB2B", brand: "GOLD", market: "B2B", type: "PLAYA" },
      { id: "CLAWD/Stock/PlayaB2C", brand: "WHITE", market: "B2C", type: "PLAYA" },
      { id: "CLAWD/Stock/PlayaB2B", brand: "WHITE", market: "B2B", type: "PLAYA" },
    ];
    
    // Agregar ubicaciones de Playa si no existen
    playaLocations.forEach(playa => {
      if (!locations.find(l => l.id === playa.id)) {
        locations.push({
          id: playa.id,
          brand: playa.brand,
          market: playa.market,
          type: playa.type,
          status: 'FREE',
          totalStock: 0,
          packages: []
        });
      }
    });
    
    const updatedLocations = locations.map(loc => {
      const myKey = extractKeyFromLocationId(loc.id);
      const realStock = contentByKey[myKey];
      let brand = "GENERIC";
      
      // Filtrar SalvaStock de Playa
      const isPlaya = loc.id.includes('Playa');
      const isSalvaStock = loc.id.includes('SalvaStock');
      
      if (isSalvaStock) {
        // Ignorar SalvaStock
        return null;
      }

      if (realStock && realStock.length > 0) {
          // Contabilizar matches por tipo
          if (loc.id.includes('Storage')) matchesB2C++;
          else if (loc.id.includes('EXTB2B')) matchesB2B++;
          else if (isPlaya) matchesPlaya++;

          const totalStock = realStock.reduce((acc, item) => acc + item.qty, 0);
          const totalReserved = realStock.reduce((acc, item) => acc + item.reservedQty, 0);
          const totalVelocity = realStock.reduce((acc, item) => acc + (item.velocity || 0), 0);
          
          const packageIdStr = realStock[0].packageId;
          const detectedBrand = detectBrandFromItem(packageIdStr, realStock[0].productCode);
          brand = detectedBrand;

          const uniquePackages = new Set();
          let totalOccupancy = 0;
          realStock.forEach(item => {
            if (!uniquePackages.has(item.packageId)) {
              uniquePackages.add(item.packageId);
              totalOccupancy += item.occupancyVal;
            }
          });
          
          // Determinar mercado para Playa
          let market = null;
          if (isPlaya) {
            if (loc.id.includes('B2B')) market = 'B2B';
            else if (loc.id.includes('B2C')) market = 'B2C';
          }

          return {
            ...loc,
            status: totalStock > 0 ? 'OCCUPIED' : 'FREE',
            totalStock: totalStock,
            totalReserved: totalReserved,
            occupancyPercentage: Math.round(totalOccupancy * 100) / 100,
            velocityScore: Math.round(totalVelocity * 100) / 100,
            packages: realStock,
            brand: brand,
            market: market,
            type: isPlaya ? 'PLAYA' : (loc.id.includes('EXTB2B') ? 'B2B' : 'B2C'),
            sinDatos: false
          };
      } else {
        // Sin stock - determinar marca estructural
        let structuralBrand = "GENERIC";
        if (loc.id.includes("BD")) structuralBrand = "BLACK";
        else if (loc.id.includes("GD")) structuralBrand = "GOLD";
        else if (loc.id.includes("WD") || loc.id.includes("WH")) structuralBrand = "WHITE";
        
        // Determinar mercado para Playa
        let market = null;
        if (isPlaya) {
          if (loc.id.includes('B2B')) market = 'B2B';
          else if (loc.id.includes('B2C')) market = 'B2C';
        }

        return {
          ...loc,
          status: 'FREE',
          totalStock: 0,
          totalReserved: 0,
          occupancyPercentage: 0,
          velocityScore: 0,
          packages: [],
          brand: structuralBrand,
          market: market,
          type: isPlaya ? 'PLAYA' : (loc.id.includes('EXTB2B') ? 'B2B' : 'B2C'),
          sinDatos: false
        };
      }
    }).filter(loc => loc !== null); // Eliminar SalvaStock

    console.log(` ✅  Sync Completo (B2C + B2B + PLAYA + MACD + ABC FIX)`);
    console.log(`     📦 B2C: ${matchesB2C} ubicaciones con stock`);
    console.log(`     📦 B2B: ${matchesB2B} ubicaciones con stock`);
    console.log(`     🏖️  Playa: ${matchesPlaya} ubicaciones con stock`);
    
    const tempFile = `${LOCATIONS_FILE}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(updatedLocations, null, 2));
    await fs.rename(tempFile, LOCATIONS_FILE);
    return updatedLocations;

  } catch (error) {
    console.error(" ❌  Error en syncWithOdoo:", error.message);
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncWithOdoo();
}