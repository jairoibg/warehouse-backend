// ==================================================================================
//  ⭐ MÓDULO DE CACHÉ CENTRALIZADO - odoo_cache.js
// ==================================================================================
//
//  Este módulo mantiene una caché única de datos de Odoo que todos los
//  componentes del Gemelo Digital pueden reutilizar:
//  - Gemelo Digital (mapa)
//  - Packing List Analyzer
//  - Devoluciones B2B
//  - Futuros módulos
//
//  BENEFICIOS:
//  - Elimina consultas duplicadas a Odoo
//  - Reduce tiempo de respuesta de 30s a <1s
//  - Menor carga en el servidor de Odoo
//  - Datos consistentes entre módulos
//
// ==================================================================================

import xmlrpc from 'xmlrpc';

// ==================================================================================
//  CONFIGURACIÓN
// ==================================================================================
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos (en ms)
const ODOO_CONFIG = {
  url: process.env.ODOO_URL,
  db: process.env.ODOO_DB,
  username: process.env.ODOO_USERNAME,
  password: process.env.ODOO_PASSWORD,
};

// ==================================================================================
//  ESTADO DE LA CACHÉ
// ==================================================================================
const cache = {
  // Datos principales
  products: new Map(),      // productId -> { id, code, name, cost, season }
  productsByCode: new Map(), // default_code.toUpperCase() -> productData
  abc: new Map(),           // productId -> 'A' | 'B' | 'C' | 'D'
  stock: new Map(),         // productId -> { total, locations: [...] }
  
  // Metadatos
  lastUpdate: null,
  isUpdating: false,
  updatePromise: null,
  stats: {
    products: 0,
    abc: 0,
    stock: 0,
    lastDuration: 0
  }
};

// ==================================================================================
//  FUNCIONES AUXILIARES ODOO
// ==================================================================================
let cachedUid = null;

async function odooAuth() {
  if (cachedUid) return cachedUid;
  
  return new Promise((resolve, reject) => {
    const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
    common.methodCall('authenticate', [
      ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
    ], (error, uid) => {
      if (error) return reject(error);
      if (!uid) return reject(new Error("Autenticación Odoo fallida"));
      cachedUid = uid;
      resolve(uid);
    });
  });
}

function odooExecute(uid, model, method, domain, options = {}) {
  return new Promise((resolve, reject) => {
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
      model, method, domain, options
    ], (err, res) => err ? reject(err) : resolve(res));
  });
}

// ==================================================================================
//  ACTUALIZACIÓN DE CACHÉ
// ==================================================================================
async function refreshCache(force = false) {
  // Si ya está actualizando, esperar a que termine
  if (cache.isUpdating && cache.updatePromise) {
    console.log('📦 [CACHE] Esperando actualización en curso...');
    return cache.updatePromise;
  }
  
  // Si la caché es válida y no forzamos, retornar
  if (!force && cache.lastUpdate && (Date.now() - cache.lastUpdate.getTime()) < CACHE_TTL) {
    console.log('📦 [CACHE] Usando caché válida');
    return cache.stats;
  }
  
  cache.isUpdating = true;
  cache.updatePromise = _doRefresh();
  
  try {
    const result = await cache.updatePromise;
    return result;
  } finally {
    cache.isUpdating = false;
    cache.updatePromise = null;
  }
}

async function _doRefresh() {
  console.log('📦 [CACHE CENTRAL] Actualizando caché de Odoo...');
  const startTime = Date.now();
  
  try {
    const uid = await odooAuth();
    
    // 1. PRODUCTOS
    console.log('  📦 Descargando productos...');
    const products = await odooExecute(uid, 'product.product', 'search_read',
      [[['default_code', '!=', false], ['active', '=', true]]],
      { fields: ['id', 'default_code', 'name', 'standard_price', 'sale_season_id'], limit: 60000 }
    );
    
    cache.products.clear();
    cache.productsByCode.clear();
    
    products.forEach(p => {
      const data = {
        id: p.id,
        code: p.default_code,
        name: p.name,
        cost: p.standard_price || 0,
        season: p.sale_season_id ? p.sale_season_id[1] : null
      };
      
      cache.products.set(p.id, data);
      
      if (p.default_code) {
        cache.productsByCode.set(p.default_code.toUpperCase().trim(), data);
      }
    });
    console.log(`    ✅ ${cache.products.size} productos`);
    
    // 2. CLASIFICACIÓN ABC
    console.log('  📊 Descargando clasificación ABC...');
    try {
      const abcData = await odooExecute(uid, 'abc.classification.product.level', 'search_read',
        [[]],
        { fields: ['product_id', 'level_id'], limit: 100000 }
      );
      
      cache.abc.clear();
      abcData.forEach(row => {
        if (row.product_id && row.level_id) {
          const productId = row.product_id[0];
          const level = row.level_id[1] || 'D';
          cache.abc.set(productId, level.charAt(0).toUpperCase());
        }
      });
      console.log(`    ✅ ${cache.abc.size} clasificaciones ABC`);
    } catch (e) {
      console.log(`    ⚠️ No se pudo cargar ABC: ${e.message}`);
    }
    
    // 3. STOCK
    console.log('  📍 Descargando stock...');
    const quants = await odooExecute(uid, 'stock.quant', 'search_read',
      [[['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]],
      { fields: ['product_id', 'location_id', 'quantity'], limit: 150000 }
    );
    
    cache.stock.clear();
    quants.forEach(q => {
      if (q.product_id) {
        const productId = q.product_id[0];
        if (!cache.stock.has(productId)) {
          cache.stock.set(productId, { total: 0, locations: [] });
        }
        const entry = cache.stock.get(productId);
        entry.total += q.quantity;
        entry.locations.push({
          id: q.location_id[0],
          name: q.location_id[1],
          qty: q.quantity
        });
      }
    });
    console.log(`    ✅ ${cache.stock.size} productos con stock`);
    
    // Actualizar metadatos
    cache.lastUpdate = new Date();
    cache.stats = {
      products: cache.products.size,
      abc: cache.abc.size,
      stock: cache.stock.size,
      lastDuration: Date.now() - startTime
    };
    
    console.log(`✅ [CACHE CENTRAL] Actualizada en ${(cache.stats.lastDuration / 1000).toFixed(1)}s\n`);
    
    return cache.stats;
    
  } catch (error) {
    console.error('❌ [CACHE CENTRAL] Error:', error.message);
    throw error;
  }
}

// ==================================================================================
//  API PÚBLICA - ACCESO A DATOS
// ==================================================================================

/**
 * Obtiene información de un producto por su código (default_code)
 * @param {string} code - Código del producto (ej: "DF-1234")
 * @returns {Object|null} Datos del producto o null
 */
function getProductByCode(code) {
  if (!code) return null;
  return cache.productsByCode.get(code.toUpperCase().trim()) || null;
}

/**
 * Obtiene información de un producto por su ID
 * @param {number} productId - ID del producto en Odoo
 * @returns {Object|null} Datos del producto o null
 */
function getProductById(productId) {
  return cache.products.get(productId) || null;
}

/**
 * Obtiene la clasificación ABC de un producto
 * @param {number} productId - ID del producto
 * @returns {string} Clasificación ABC ('A', 'B', 'C', 'D')
 */
function getABC(productId) {
  return cache.abc.get(productId) || 'D';
}

/**
 * Obtiene información de stock de un producto
 * @param {number} productId - ID del producto
 * @returns {Object|null} { total, locations: [...] } o null
 */
function getStock(productId) {
  return cache.stock.get(productId) || null;
}

/**
 * Obtiene el estado actual de la caché
 * @returns {Object} Estadísticas y metadatos
 */
function getCacheStatus() {
  return {
    isValid: cache.lastUpdate && (Date.now() - cache.lastUpdate.getTime()) < CACHE_TTL,
    lastUpdate: cache.lastUpdate,
    stats: cache.stats,
    ttlRemaining: cache.lastUpdate 
      ? Math.max(0, CACHE_TTL - (Date.now() - cache.lastUpdate.getTime()))
      : 0
  };
}

/**
 * Enriquece una lista de referencias con datos de Odoo
 * @param {string[]} codes - Array de códigos de producto
 * @returns {Object[]} Datos enriquecidos
 */
function enrichReferences(codes) {
  return codes.map(code => {
    const product = getProductByCode(code);
    if (!product) {
      return {
        code,
        found: false,
        abc: 'NEW',
        stock: 0,
        locations: []
      };
    }
    
    const abc = getABC(product.id);
    const stockInfo = getStock(product.id);
    
    return {
      code,
      found: true,
      productId: product.id,
      name: product.name,
      cost: product.cost,
      season: product.season,
      abc,
      stock: stockInfo?.total || 0,
      locations: stockInfo?.locations?.slice(0, 5) || []
    };
  });
}

// ==================================================================================
//  EXPORTACIONES
// ==================================================================================
export const odooCache = {
  // Gestión de caché
  refresh: refreshCache,
  getStatus: getCacheStatus,
  
  // Acceso a datos
  getProductByCode,
  getProductById,
  getABC,
  getStock,
  enrichReferences,
  
  // Acceso directo a mapas (para casos avanzados)
  _products: cache.products,
  _productsByCode: cache.productsByCode,
  _abc: cache.abc,
  _stock: cache.stock
};

export default odooCache;