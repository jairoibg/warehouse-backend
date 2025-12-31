/**
 * Servicio centralizado para todas las operaciones con Odoo
 * Elimina duplicación de código y centraliza la lógica de conexión
 */

import xmlrpc from 'xmlrpc';
import { getOdooConfig } from '../config/odooConfig.js';
import { explanationEngine } from '../../explanation_engine.js';

const ODOO_CONFIG = getOdooConfig();

/**
 * Autentica con Odoo y retorna el UID
 * @returns {Promise<number>} User ID de Odoo
 */
export async function odooAuth() {
  return new Promise((resolve, reject) => {
    const common = xmlrpc.createSecureClient({ 
      url: `${ODOO_CONFIG.url}/xmlrpc/2/common` 
    });
    
    common.methodCall('authenticate', [
      ODOO_CONFIG.db, 
      ODOO_CONFIG.username, 
      ODOO_CONFIG.password, 
      {}
    ], (error, uid) => {
      if (error) return reject(error);
      if (!uid) {
        return reject(new Error("Autenticación fallida. Revisa credenciales en .env"));
      }
      resolve(uid);
    });
  });
}

/**
 * Ejecuta una operación en Odoo
 * @param {string} model - Modelo de Odoo (ej: 'product.product')
 * @param {string} method - Método a ejecutar (ej: 'search_read')
 * @param {Array} params - Parámetros para el método
 * @param {Object} options - Opciones adicionales (fields, limit, offset, etc)
 * @returns {Promise<any>} Resultado de la operación
 */
export async function odooExecute(model, method, params = [], options = {}) {
  const uid = await odooAuth();
  const startTime = Date.now();
  
  return new Promise((resolve, reject) => {
    const models = xmlrpc.createSecureClient({ 
      url: `${ODOO_CONFIG.url}/xmlrpc/2/object` 
    });
    
    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, 
      uid, 
      ODOO_CONFIG.password,
      model, 
      method, 
      params, 
      options
    ], (error, result) => {
      const executionTime = Date.now() - startTime;
      
      // Registrar para explicabilidad
      if (explanationEngine && explanationEngine.registerOdooQuery) {
        explanationEngine.registerOdooQuery(
          `${model}.${method}`,
          { params, options },
          result,
          executionTime
        );
      }
      
      if (error) return reject(error);
      resolve(result);
    });
  });
}

/**
 * Obtiene todos los registros de un modelo con paginación automática
 * @param {string} model - Modelo de Odoo
 * @param {Array} domain - Dominio de búsqueda
 * @param {Array} fields - Campos a obtener
 * @param {number} batchSize - Tamaño de lote (default: 2000)
 * @returns {Promise<Array>} Todos los registros
 */
export async function fetchAllRecords(model, domain = [], fields = [], batchSize = 2000) {
  let allRecords = [];
  let offset = 0;
  let hasMore = true;

  if (model === 'stock.move') {
    process.stdout.write(` 📡  Descargando ${model}... `);
  }

  while (hasMore) {
    try {
      const batch = await odooExecute(model, 'search_read', [domain], {
        fields,
        offset,
        limit: batchSize
      });

      allRecords = allRecords.concat(batch);
      offset += batchSize;

      if (model === 'stock.move') {
        process.stdout.write('.');
      }

      if (batch.length < batchSize) {
        hasMore = false;
      }

      // Pequeña pausa para no saturar Odoo
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      console.error(`\n ❌ Error en batch ${offset}:`, error.message);
      hasMore = false;
    }
  }

  if (model === 'stock.move') {
    console.log(` ✅ (${allRecords.length})`);
  }

  return allRecords;
}

/**
 * Obtiene detalles de productos
 * @param {Array<number>} productIds - IDs de productos
 * @param {Array<string>} fields - Campos a obtener
 * @returns {Promise<Array>} Productos con sus detalles
 */
export async function fetchProductDetails(productIds, fields = ['name', 'default_code', 'standard_price', 'sale_season_id']) {
  if (productIds.length === 0) return [];
  
  return odooExecute('product.product', 'read', [productIds], { fields });
}

/**
 * Obtiene clasificación ABC de productos
 * @param {Array<number>} productIds - IDs de productos
 * @returns {Promise<Object>} Mapa de product_id -> ABC class
 */
export async function fetchABCData(productIds) {
  if (productIds.length === 0) return [];

  try {
    const results = await odooExecute(
      'abc.classification.product.level',
      'search_read',
      [[['product_id', 'in', productIds]]],
      { fields: ['product_id', 'level_id'] }
    );

    const abcMap = {};
    results.forEach(row => {
      if (row.product_id && row.level_id) {
        const pid = row.product_id[0];
        const letter = (row.level_id[1] || 'D').charAt(0).toUpperCase();
        // Si hay múltiples, tomar la mejor (A > B > C > D)
        if (!abcMap[pid] || letter < abcMap[pid]) {
          abcMap[pid] = letter;
        }
      }
    });

    return abcMap;
  } catch (error) {
    console.error(" ❌  Error ABC:", error.message);
    return {};
  }
}

/**
 * Obtiene ventas de los últimos N días
 * @param {number} daysBack - Días hacia atrás
 * @returns {Promise<Array>} Líneas de venta
 */
export async function getRealTimeSales(daysBack = 7) {
  try {
    const date = new Date();
    date.setDate(date.getDate() - daysBack);
    const dateStr = date.toISOString().split('T')[0];

    const results = await odooExecute(
      'sale.order.line',
      'search_read',
      [[
        ['order_id.date_order', '>=', dateStr],
        ['state', 'in', ['sale', 'done']]
      ]],
      { fields: ['product_id', 'product_uom_qty', 'price_total'] }
    );

    // Filtrar productos de servicio/envío
    return results
      .filter(r => {
        const name = (r.product_id && r.product_id[1]) ? r.product_id[1].toUpperCase() : "";
        return !["OUTVIO", "TRANSPORT", "SHIPPING", "ENVIO", "DISCOUNT"].some(x => name.includes(x));
      })
      .map(r => ({
        p: r.product_id[1],
        q: r.product_uom_qty,
        v: r.price_total
      }));
  } catch (error) {
    console.error("Error obteniendo ventas:", error.message);
    return [];
  }
}



