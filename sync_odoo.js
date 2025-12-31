import 'dotenv/config';
import xmlrpc from 'xmlrpc';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { explanationEngine } from './explanation_engine.js';
import { getOdooConfig } from './src/config/odooConfig.js';

// --- CONFIGURACIÓN ODOO (SEGURA) ---
const ODOO_CONFIG = getOdooConfig();

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
//  CONECTORES ODOO
// ==================================================================================
// Usar servicio centralizado
import { odooAuth as odooAuthService, odooExecute } from './src/services/odooService.js';

function odooAuth() {
  return odooAuthService();
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

async function fetchSupplierInfo(uid, productIds) {
  if (productIds.length === 0) return {};
  
  try {
    // product.supplierinfo tiene product_tmpl_id (template), no product_id directamente
    // Necesitamos obtener los product_template_id de los productos primero
    // PROCESAR EN LOTES PARA EVITAR TIMEOUT
    const BATCH_SIZE = 500; // Lotes de 500 productos
    const productToTemplate = {};
    const allTemplateIds = new Set();
    
    for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
      const batch = productIds.slice(i, i + BATCH_SIZE);
      
      try {
        const products = await odooExecute(
          'product.product',
          'read',
          [batch],
          { fields: ['id', 'product_tmpl_id'] }
        );
        
        products.forEach(p => {
          const pid = p.id;
          const tid = p.product_tmpl_id ? (Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id) : null;
          if (tid) {
            productToTemplate[pid] = tid;
            allTemplateIds.add(tid);
          }
        });
        
        // Pequeña pausa entre lotes
        if (i + BATCH_SIZE < productIds.length) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (error) {
        console.warn(`⚠️  Error en lote de productos ${Math.floor(i/BATCH_SIZE) + 1}:`, error.message);
      }
    }
    
    const templateIds = Array.from(allTemplateIds);
    
    if (templateIds.length === 0) {
      return { costMap: {}, currencyMap: {} };
    }
    
    // Obtener supplierinfo en lotes también
    const TEMPLATE_BATCH_SIZE = 200;
    const templateCostMap = {};
    const templateCurrencyMap = {};
    
    for (let i = 0; i < templateIds.length; i += TEMPLATE_BATCH_SIZE) {
      const batch = templateIds.slice(i, i + TEMPLATE_BATCH_SIZE);
      
      try {
        // Sin límite para obtener todos los supplierinfo - Odoo manejará la paginación si es necesario
        const supplierInfos = await odooExecute(
          'product.supplierinfo',
          'search_read',
          [[['product_tmpl_id', 'in', batch]]],
          { fields: ['product_tmpl_id', 'price', 'currency_id', 'sequence'] }
        );
        
        supplierInfos.forEach(si => {
          const tid = si.product_tmpl_id ? (Array.isArray(si.product_tmpl_id) ? si.product_tmpl_id[0] : si.product_tmpl_id) : null;
          if (tid && si.price !== undefined && si.price !== null && si.price > 0) {
            // Si ya existe, mantener el primero (o el de menor sequence)
            const sequence = si.sequence || 0;
            if (!templateCostMap[tid] || sequence < (templateCostMap[tid].sequence || 9999)) {
              templateCostMap[tid] = { price: si.price, sequence: sequence };
              templateCurrencyMap[tid] = si.currency_id ? (Array.isArray(si.currency_id) ? si.currency_id[1] : si.currency_id) : 'EUR';
            }
          }
        });
        
        // Pequeña pausa entre lotes
        if (i + TEMPLATE_BATCH_SIZE < templateIds.length) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (error) {
        console.warn(`⚠️  Error en lote de templates ${Math.floor(i/TEMPLATE_BATCH_SIZE) + 1}:`, error.message);
      }
    }
    
    // Convertir template map a product map
    const costMap = {};
    const currencyMap = {};
    Object.entries(productToTemplate).forEach(([pid, tid]) => {
      if (templateCostMap[tid]) {
        costMap[pid] = templateCostMap[tid].price;
        currencyMap[pid] = templateCurrencyMap[tid];
      }
    });
    
    return { costMap, currencyMap };
  } catch (error) {
    console.warn("⚠️  Error obteniendo supplierinfo, usando standard_price como fallback:", error.message);
    return { costMap: {}, currencyMap: {} };
  }
}

async function getCurrencyRate(uid, currencyCode) {
  if (!currencyCode || currencyCode === 'EUR') return 1.0;
  
  try {
    const currencies = await odooExecute(
      'res.currency',
      'search_read',
      [[['name', '=', currencyCode]]],
      { fields: ['rate_ids'] }
    );
    
    if (currencies.length > 0) {
      // Obtener la tasa más reciente
      const currencyId = currencies[0].id;
      const rates = await odooExecute(
        'res.currency.rate',
        'search_read',
        [[['currency_id', '=', currencyId]]],
        { fields: ['rate'], order: 'name desc', limit: 1 }
      );
      
      if (rates.length > 0 && rates[0].rate) {
        return rates[0].rate;
      }
    }
    return 1.0;
  } catch (error) {
    console.warn(`⚠️  Error obteniendo tasa de cambio para ${currencyCode}, usando 1.0:`, error.message);
    return 1.0;
  }
}

async function fetchProductDetails(uid, productIds) {
  if (productIds.length === 0) return [];
  
  const allProducts = [];
  const BATCH_SIZE = 500; // Procesar en lotes de 500 para evitar problemas
  const totalBatches = Math.ceil(productIds.length / BATCH_SIZE);
  
  for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
    const batch = productIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i/BATCH_SIZE) + 1;
    
    try {
      const products = await odooExecute(
        'product.product',
        'read',
        [batch],
        { fields: ['id', 'name', 'default_code', 'standard_price', 'sale_season_id'] }
      );
      
      if (products && Array.isArray(products)) {
        allProducts.push(...products);
      }
      
      // Pausa entre lotes
      if (i + BATCH_SIZE < productIds.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (error) {
      console.warn(`⚠️  Error en lote de productos ${batchNum}/${totalBatches}:`, error.message);
      // Continuar con el siguiente lote
    }
  }
  
  console.log(` ✅  [PRODUCTOS] Obtenidos ${allProducts.length} de ${productIds.length} productos`);
  return allProducts;
}

async function fetchABCData(uid, productIds) {
  if (productIds.length === 0) return [];
  const startTime = Date.now();
  
  try {
    const results = await odooExecute(
      'abc.classification.product.level',
      'search_read',
      [[['product_id', 'in', productIds]]],
      { fields: ['product_id', 'level_id'] }
    );
    
    // REGISTRO DE EXPLICABILIDAD
    const executionTime = Date.now() - startTime;
    explanationEngine.registerOdooQuery(
      'abc.classification.product.level.search_read',
      { productIds: productIds.slice(0, 10), count: productIds.length },
      results,
      executionTime
    );
    
    console.log(` 📊  [ABC] Clasificaciones encontradas en Odoo: ${results.length} de ${productIds.length} productos`);
    return results;
  } catch (error) {
    console.error(" ❌  Error ABC:", error);
    console.warn(" ⚠️  [ABC] No se pudieron obtener clasificaciones de Odoo, se calcularán automáticamente");
    return [];
  }
}

// --- MOTOR DE AUTO-CLASIFICACIÓN DE HUÉRFANOS (MACD) ---
async function calculateOrphanABC(uid, orphanIds) {
    if (orphanIds.length === 0) return {};

    console.log(` 🚑  [MACD] Calculando ABC para ${orphanIds.length} productos huérfanos...`);
    
    // Extender período a 90 días para tener más datos de ventas
    const date = new Date();
    date.setDate(date.getDate() - 90);
    const dateStr = date.toISOString().split('T')[0];
    
    try {
        const startTime = Date.now();
        // Limitar a 1000 productos por consulta para evitar problemas
        const sales = [];
        const BATCH_SIZE_SALES = 1000;
        for (let i = 0; i < orphanIds.length; i += BATCH_SIZE_SALES) {
          const batch = orphanIds.slice(i, i + BATCH_SIZE_SALES);
          try {
            const batchSales = await odooExecute(
              'sale.order.line',
              'search_read',
              [[['product_id', 'in', batch], ['order_id.date_order', '>=', dateStr], ['state', 'in', ['sale', 'done']]]],
              { fields: ['product_id', 'price_total'], limit: 50000 }
            );
            sales.push(...(batchSales || []));
          } catch (error) {
            console.warn(`⚠️  Error en lote de ventas ${Math.floor(i/BATCH_SIZE_SALES) + 1}:`, error.message);
          }
        }

        const executionTime = Date.now() - startTime;
        explanationEngine.registerOdooQuery(
          'sale.order.line.search_read.macd',
          { orphanIds: orphanIds.slice(0, 10), count: orphanIds.length, dateFrom: dateStr },
          sales,
          executionTime
        );

        const salesMap = {};
        let totalRevenue = 0;
        
        console.log(` 📊  [MACD] Ventas encontradas: ${sales.length} líneas de pedido`);
        
        sales.forEach(s => {
            const pid = s.product_id[0];
            const val = s.price_total || 0;
            salesMap[pid] = (salesMap[pid] || 0) + val;
            totalRevenue += val;
        });
        
        console.log(` 📊  [MACD] Productos con ventas: ${Object.keys(salesMap).length} de ${orphanIds.length}, Revenue total: ${totalRevenue.toFixed(2)}€`);

        const rankedProducts = orphanIds.map(id => ({
            id: id,
            value: salesMap[id] || 0
        })).sort((a, b) => b.value - a.value);

        const calculatedABC = {};
        let currentSum = 0;
        
        // Si no hay ventas en absoluto, intentar con un período más largo (365 días)
        if (totalRevenue === 0 && orphanIds.length > 0) {
            console.warn(` ⚠️  [MACD] No se encontraron ventas en 90 días. Intentando con 365 días...`);
            const date365 = new Date();
            date365.setDate(date365.getDate() - 365);
            const dateStr365 = date365.toISOString().split('T')[0];
            
            try {
                const sales365 = await odooExecute(
                    'sale.order.line',
                    'search_read',
                    [[['product_id', 'in', orphanIds], ['order_id.date_order', '>=', dateStr365], ['state', 'in', ['sale', 'done']]]],
                    { fields: ['product_id', 'price_total'] }
                );
                
                sales365.forEach(s => {
                    const pid = s.product_id[0];
                    const val = s.price_total || 0;
                    salesMap[pid] = (salesMap[pid] || 0) + val;
                    totalRevenue += val;
                });
                
                // Re-ordenar con los nuevos datos
                rankedProducts.forEach(p => {
                    p.value = salesMap[p.id] || 0;
                });
                rankedProducts.sort((a, b) => b.value - a.value);
                
                if (totalRevenue > 0) {
                    console.log(` ✅  [MACD] Encontradas ventas en 365 días: ${totalRevenue.toFixed(2)}€`);
                }
            } catch (e) {
                console.warn(` ⚠️  [MACD] Error al buscar ventas de 365 días:`, e.message);
            }
        }

        rankedProducts.forEach(p => {
            if (p.value === 0 || totalRevenue === 0) {
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
            dataSource: 'sale.order.line últimos 90 días',
            confidence: 'MEDIUM'
          }
        );

        // Contar clasificaciones asignadas
        const counts = { A: 0, B: 0, C: 0, D: 0 };
        Object.values(calculatedABC).forEach(cls => { counts[cls] = (counts[cls] || 0) + 1; });
        console.log(` ✅  [MACD] Clasificación completada: A=${counts.A}, B=${counts.B}, C=${counts.C}, D=${counts.D}`);
        return calculatedABC;

    } catch (e) {
        console.error("Error en Auto-Clasificación:", e);
        return {};
    }
}

// BI: Ventas Reales (Exportada) - Usa servicio centralizado
export async function getRealTimeSales(daysBack) {
  const { getRealTimeSales: getSales } = await import('./src/services/odooService.js');
  return getSales(daysBack);
}

// Velocidad Interna (90 días) - OPTIMIZADO PARA LOTES
async function fetchSalesVelocity(uid, productIds) {
  if (productIds.length === 0) return {};
  
  const date = new Date(); 
  date.setDate(date.getDate() - 90);
  const dateStr = date.toISOString().split('T')[0];
  
  const salesMap = {};
  const VELOCITY_BATCH_SIZE = 1000; // Procesar en lotes de 1000
  
  // Procesar en lotes para evitar problemas
  for (let i = 0; i < productIds.length; i += VELOCITY_BATCH_SIZE) {
    const batch = productIds.slice(i, i + VELOCITY_BATCH_SIZE);
    
    try {
      const results = await odooExecute(
        'sale.order.line',
        'search_read',
        [[['product_id', 'in', batch], ['order_id.date_order', '>=', dateStr], ['state', 'in', ['sale', 'done']]]],
        { fields: ['product_id', 'product_uom_qty'], limit: 50000 }
      );
      
      if (results && Array.isArray(results)) {
        results.forEach(line => {
          if (line.product_id && Array.isArray(line.product_id) && line.product_id[0]) {
            const pid = line.product_id[0];
            const qty = line.product_uom_qty || 0;
            if (!salesMap[pid]) salesMap[pid] = 0;
            salesMap[pid] += qty;
          }
        });
      }
      
      // Pausa entre lotes
      if (i + VELOCITY_BATCH_SIZE < productIds.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      // Continuar con el siguiente lote si hay error
      console.warn(`⚠️  Error en lote de velocidad ${Math.floor(i/VELOCITY_BATCH_SIZE) + 1}:`, error.message);
    }
  }
  
  const velocityMap = {};
  for (const [pid, total] of Object.entries(salesMap)) {
    velocityMap[pid] = parseFloat((total / 90).toFixed(4));
  }
  
  return velocityMap;
}

async function fetchAllStock(uid) {
  let allQuants = [];
  let offset = 0;
  const BATCH_SIZE = 15000; // Aumentado de 5000 a 15000 para mayor eficiencia
  let keepFetching = true;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;
  
  console.log(" ⏳  Iniciando descarga de stock (B2C + B2B)...");
  while (keepFetching) {
    try {
      const batch = await fetchBatchStock(uid, offset, BATCH_SIZE);
      if (!batch || !Array.isArray(batch)) {
        console.warn(`\n ⚠️  Lote en offset ${offset} no es un array válido, saltando...`);
        offset += BATCH_SIZE;
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error("\n ❌  Demasiados errores consecutivos, deteniendo descarga");
          break;
        }
        continue;
      }
      
      allQuants = allQuants.concat(batch);
      offset += BATCH_SIZE;
      consecutiveErrors = 0; // Reset contador de errores
      process.stdout.write(`\r   ... ${allQuants.length} líneas bajadas`);
      if (batch.length < BATCH_SIZE) keepFetching = false;
    } catch (err) {
      console.error(`\n ❌  Error en lote offset ${offset}:`, err.message);
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error("\n ❌  Demasiados errores consecutivos, deteniendo descarga");
        break;
      }
      // Intentar continuar con el siguiente lote
      offset += BATCH_SIZE;
    }
  }
  console.log(`\n 📦  Stock descargado: ${allQuants.length} quants`);
  return allQuants;
}

// ==================================================================================
//  ORQUESTADOR PRINCIPAL - MODIFICADO PARA B2C + B2B
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
    
    // Ejecutar en paralelo pero con manejo de errores individual
    let productsInfo = [];
    let abcData = [];
    let velocityMap = {};
    let supplierData = { costMap: {}, currencyMap: {} };
    
    try {
      [productsInfo, abcData, velocityMap, supplierData] = await Promise.all([
        fetchProductDetails(uid, productIds).catch(err => {
          console.error("❌ Error en fetchProductDetails:", err.message);
          return [];
        }),
        fetchABCData(uid, productIds).catch(err => {
          console.error("❌ Error en fetchABCData:", err.message);
          return [];
        }),
        fetchSalesVelocity(uid, productIds).catch(err => {
          console.error("❌ Error en fetchSalesVelocity:", err.message);
          return {};
        }),
        fetchSupplierInfo(uid, productIds).catch(err => {
          console.error("❌ Error en fetchSupplierInfo:", err.message);
          return { costMap: {}, currencyMap: {} };
        })
      ]);
    } catch (error) {
      console.error("❌ Error crítico en Promise.all:", error.message);
      // Continuar con valores por defecto para no perder datos
    }
    
    const { costMap: supplierCostMap = {}, currencyMap = {} } = supplierData || { costMap: {}, currencyMap: {} };
    
    // Obtener tasas de cambio únicas
    const uniqueCurrencies = [...new Set(Object.values(currencyMap))].filter(c => c && c !== 'EUR');
    const currencyRates = {};
    for (const curr of uniqueCurrencies) {
      currencyRates[curr] = await getCurrencyRate(uid, curr);
    }
    currencyRates['EUR'] = 1.0;
    
    // Logging de estadísticas de costes
    const supplierCount = Object.keys(supplierCostMap).length;
    console.log(` 💰  [COSTES] Costes obtenidos desde supplierinfo: ${supplierCount} productos de ${productIds.length} (${((supplierCount/productIds.length)*100).toFixed(1)}%)`);
    console.log(`       El resto usará standard_price como fallback`);

    // --- LÓGICA HÍBRIDA DE CLASIFICACIÓN ABC ---
    const abcMap = {};
    const foundIds = new Set();
    
    console.log(` 📊  [ABC] Procesando ${abcData.length} clasificaciones de Odoo para ${productIds.length} productos...`);
    
    abcData.forEach(row => {
      const pid = row.product_id[0];
      foundIds.add(pid);
      const letter = row.level_id ? (Array.isArray(row.level_id) ? row.level_id[1] : row.level_id) : "D";
      const current = abcMap[pid] || "D";
      // Tomar la mejor clasificación (A < B < C < D)
      if (letter < current) abcMap[pid] = letter;
      else if (!abcMap[pid]) abcMap[pid] = letter;
    });

    const orphanIds = productIds.filter(id => !foundIds.has(id));
    console.log(` 📊  [ABC] Productos con clasificación de Odoo: ${foundIds.size}, sin clasificación: ${orphanIds.length}`);
    
    // Si no se encontraron clasificaciones en Odoo o hay muchos huérfanos, calcular para todos
    let calculatedABC = {};
    if (orphanIds.length > 0) {
        calculatedABC = await calculateOrphanABC(uid, orphanIds);
        
        // Si no se calcularon suficientes (todos son D), intentar con todos los productos
        const nonDCount = Object.values(calculatedABC).filter(cls => cls !== 'D').length;
        console.log(` 📊  [ABC] Clasificaciones calculadas: ${Object.keys(calculatedABC).length} productos (${nonDCount} no-D)`);
        
        if (nonDCount === 0 && orphanIds.length > 10) {
            console.warn(` ⚠️  [ABC] Todos los productos calculados son D. Recalculando con todos los productos...`);
            calculatedABC = await calculateOrphanABC(uid, productIds);
            const newNonDCount = Object.values(calculatedABC).filter(cls => cls !== 'D').length;
            console.log(` 📊  [ABC] Después de recalcular: ${newNonDCount} productos no-D`);
        }
    } else if (abcData.length === 0 && productIds.length > 0) {
        // Si no se obtuvo ninguna clasificación de Odoo, calcular para todos
        console.warn(` ⚠️  [ABC] No se obtuvieron clasificaciones de Odoo. Calculando ABC para todos los productos...`);
        calculatedABC = await calculateOrphanABC(uid, productIds);
        const nonDCount = Object.values(calculatedABC).filter(cls => cls !== 'D').length;
        console.log(` 📊  [ABC] Clasificaciones calculadas para todos: ${Object.keys(calculatedABC).length} productos (${nonDCount} no-D)`);
    }
    
    // Log final de distribución ABC
    const finalABCMap = { ...abcMap, ...calculatedABC };
    const finalCounts = { A: 0, B: 0, C: 0, D: 0 };
    Object.values(finalABCMap).forEach(cls => {
        finalCounts[cls] = (finalCounts[cls] || 0) + 1;
    });
    console.log(` ✅  [ABC] Distribución final: A=${finalCounts.A}, B=${finalCounts.B}, C=${finalCounts.C}, D=${finalCounts.D}`);

    // --- MAPEO FINAL ---
    const productMeta = {};
    
    // Verificar que productsInfo no esté vacío
    if (!productsInfo || productsInfo.length === 0) {
      console.error("❌ CRÍTICO: productsInfo está vacío. Esto causará pérdida de datos.");
      console.error("   El proceso continuará pero con valores por defecto para todos los productos.");
    } else {
      console.log(` ✅  [PRODUCTOS] Mapeando ${productsInfo.length} productos...`);
    }
    
    if (productsInfo && Array.isArray(productsInfo)) {
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
        
        const finalABC = abcMap[p.id] || calculatedABC[p.id] || "D";

        // Obtener coste desde supplierinfo (preferido) o standard_price como fallback
        // IMPORTANTE: standard_price ya está en la moneda de la compañía (normalmente EUR)
        // supplierinfo puede estar en otra moneda y necesita conversión
        let productCost = 0;
        
        if (supplierCostMap[p.id] && supplierCostMap[p.id] > 0) {
          const currency = currencyMap[p.id] || 'EUR';
          const rate = currencyRates[currency] || 1.0;
          productCost = supplierCostMap[p.id] * rate;
        } else if (p.standard_price && p.standard_price > 0) {
          // standard_price ya está en EUR (moneda base de la compañía)
          productCost = p.standard_price;
        } else {
          productCost = 0;
        }

        productMeta[p.id] = {
          abcClass: finalABC,
          velocity: velocityMap[p.id] || 0,
          cost: productCost,
          name: p.name || "",
          code: ref,
          season: seasonReal,
          occupancyPerBox: occupancyPerBox
        };
      });
      
      // Estadísticas de costes
      let statsSupplier = 0;
      let statsStandard = 0;
      let statsNone = 0;
      productsInfo.forEach(p => {
        if (supplierCostMap[p.id] && supplierCostMap[p.id] > 0) {
          statsSupplier++;
        } else if (p.standard_price && p.standard_price > 0) {
          statsStandard++;
        } else {
          statsNone++;
        }
      });
      console.log(` 💰  [COSTES] Estadísticas finales:`);
      console.log(`       - Desde supplierinfo: ${statsSupplier} (${((statsSupplier/productsInfo.length)*100).toFixed(1)}%)`);
      console.log(`       - Desde standard_price: ${statsStandard} (${((statsStandard/productsInfo.length)*100).toFixed(1)}%)`);
      console.log(`       - Sin coste: ${statsNone} (${((statsNone/productsInfo.length)*100).toFixed(1)}%)`);
    }

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

    console.log(` ✅  Sync Completo (B2C + B2B + PLAYA + MACD + Explicabilidad)`);
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
