/**
 * Script optimizado para obtener costes de variantes
 * Versión rápida con timeout extendido y procesamiento eficiente
 */

import 'dotenv/config';
import { odooAuth, odooExecute } from './src/services/odooService.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCATIONS_FILE = path.join(__dirname, 'data', 'locations.json');

// Configuración de timeouts
const BATCH_SIZE = 100; // Tamaño de lote para búsquedas
const DELAY_BETWEEN_BATCHES = 200; // ms entre lotes

async function obtenerCostesOptimizado() {
  console.log('🚀 OBTENCIÓN OPTIMIZADA DE COSTES DE VARIANTES\n');
  console.log('='.repeat(80));
  
  try {
    // 1. Cargar datos locales
    console.log('\n📂 1. Cargando datos locales...');
    const rawData = await fs.readFile(LOCATIONS_FILE, 'utf-8');
    const locations = JSON.parse(rawData);
    
    // 2. Extraer códigos únicos de productos
    console.log('\n📊 2. Extrayendo códigos únicos...');
    const productCodesSet = new Set();
    
    locations.forEach(loc => {
      if (!loc.packages || loc.packages.length === 0) return;
      loc.packages.forEach(pkg => {
        const code = pkg.productCode || pkg.surtido || null;
        if (code && code !== 'SIN_REF') {
          productCodesSet.add(code);
        }
      });
    });
    
    const productCodes = Array.from(productCodesSet);
    console.log(`   ✅ ${productCodes.length.toLocaleString()} códigos únicos encontrados`);
    
    // 3. Conectar a Odoo
    console.log('\n🔌 3. Conectando a Odoo...');
    const uid = await odooAuth();
    console.log(`   ✅ Conectado (UID: ${uid})`);
    
    // 4. Buscar productos en Odoo (en lotes grandes pero con límite)
    console.log('\n🔍 4. Buscando productos en Odoo...');
    const productMap = new Map(); // code -> { id, tmpl_id, standard_price }
    
    // Procesar en lotes más pequeños para evitar timeout
    for (let i = 0; i < productCodes.length; i += BATCH_SIZE) {
      const batch = productCodes.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(productCodes.length / BATCH_SIZE);
      
      process.stdout.write(`\r   Lote ${batchNum}/${totalBatches} (${Math.floor((i/productCodes.length)*100)}%)...`);
      
      try {
        const products = await Promise.race([
          odooExecute(
            'product.product',
            'search_read',
            [[['default_code', 'in', batch]]],
            { fields: ['id', 'default_code', 'product_tmpl_id', 'standard_price'] }
          ),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout en búsqueda de productos')), 30000)
          )
        ]);
        
        products.forEach(p => {
          const code = p.default_code || '';
          if (code) {
            productMap.set(code, {
              product_id: p.id,
              product_tmpl_id: p.product_tmpl_id ? (Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id) : null,
              standard_price: p.standard_price || 0
            });
          }
        });
        
        // Pausa entre lotes
        if (i + BATCH_SIZE < productCodes.length) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
        }
      } catch (error) {
        console.error(`\n   ⚠️  Error en lote ${batchNum}: ${error.message}`);
        // Continuar con siguiente lote
      }
    }
    
    console.log(`\n   ✅ ${productMap.size.toLocaleString()} productos encontrados en Odoo`);
    
    // 5. Obtener templates únicos
    console.log('\n🔍 5. Obteniendo templates únicos...');
    const templateIds = [...new Set(
      Array.from(productMap.values())
        .map(p => p.product_tmpl_id)
        .filter(Boolean)
    )];
    console.log(`   ✅ ${templateIds.length.toLocaleString()} templates únicos`);
    
    // 6. Buscar supplierinfo en lotes
    console.log('\n💰 6. Obteniendo costes desde supplierinfo...');
    const supplierInfoMap = new Map(); // tmpl_id -> { price, currency, sequence }
    
    for (let i = 0; i < templateIds.length; i += BATCH_SIZE) {
      const batch = templateIds.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(templateIds.length / BATCH_SIZE);
      
      process.stdout.write(`\r   Lote ${batchNum}/${totalBatches} (${Math.floor((i/templateIds.length)*100)}%)...`);
      
      try {
        const supplierInfos = await Promise.race([
          odooExecute(
            'product.supplierinfo',
            'search_read',
            [[['product_tmpl_id', 'in', batch]]],
            { fields: ['product_tmpl_id', 'price', 'currency_id', 'sequence'] }
          ),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout en supplierinfo')), 30000)
          )
        ]);
        
        supplierInfos.forEach(si => {
          const tmplId = si.product_tmpl_id ? 
            (Array.isArray(si.product_tmpl_id) ? si.product_tmpl_id[0] : si.product_tmpl_id) : null;
          
          if (tmplId && si.price !== undefined && si.price !== null && si.price > 0) {
            const sequence = si.sequence || 9999;
            
            if (!supplierInfoMap.has(tmplId) || sequence < (supplierInfoMap.get(tmplId).sequence || 9999)) {
              supplierInfoMap.set(tmplId, {
                price: si.price,
                currency: si.currency_id ? 
                  (Array.isArray(si.currency_id) ? si.currency_id[1] : si.currency_id) : 'EUR',
                sequence: sequence
              });
            }
          }
        });
        
        // Pausa entre lotes
        if (i + BATCH_SIZE < templateIds.length) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
        }
      } catch (error) {
        console.error(`\n   ⚠️  Error en lote ${batchNum}: ${error.message}`);
        // Continuar
      }
    }
    
    console.log(`\n   ✅ ${supplierInfoMap.size.toLocaleString()} templates con supplierinfo`);
    
    // 7. Obtener tasas de cambio (solo monedas no EUR)
    console.log('\n💱 7. Obteniendo tasas de cambio...');
    const currencies = [...new Set(Array.from(supplierInfoMap.values()).map(s => s.currency).filter(c => c && c !== 'EUR'))];
    const currencyRates = { 'EUR': 1.0 };
    
    for (const curr of currencies) {
      try {
        const currencyRecords = await odooExecute(
          'res.currency',
          'search_read',
          [[['name', '=', curr]]],
          { fields: ['id'], limit: 1 }
        );
        
        if (currencyRecords.length > 0) {
          const currencyId = currencyRecords[0].id;
          const rates = await odooExecute(
            'res.currency.rate',
            'search_read',
            [[['currency_id', '=', currencyId]]],
            { fields: ['rate'], order: 'name desc', limit: 1 }
          );
          
          if (rates.length > 0 && rates[0].rate) {
            currencyRates[curr] = rates[0].rate;
          } else {
            currencyRates[curr] = 1.0;
          }
        }
      } catch (error) {
        console.warn(`   ⚠️  Error obteniendo tasa para ${curr}: ${error.message}`);
        currencyRates[curr] = 1.0;
      }
    }
    
    console.log(`   ✅ ${currencies.length} monedas procesadas`);
    
    // 8. Crear mapa final de costes por código
    console.log('\n📋 8. Creando mapa final de costes...');
    const costMap = new Map(); // code -> { cost, source, currency, rate }
    
    productCodes.forEach(code => {
      const productData = productMap.get(code);
      
      if (!productData) {
        costMap.set(code, { cost: 0, source: 'NOT_FOUND' });
        return;
      }
      
      const tmplId = productData.product_tmpl_id;
      const supplierInfo = tmplId ? supplierInfoMap.get(tmplId) : null;
      
      if (supplierInfo) {
        const rate = currencyRates[supplierInfo.currency] || 1.0;
        costMap.set(code, {
          cost: supplierInfo.price * rate,
          source: 'SUPPLIERINFO',
          currency: supplierInfo.currency,
          originalPrice: supplierInfo.price,
          rate: rate
        });
      } else if (productData.standard_price > 0) {
        costMap.set(code, {
          cost: productData.standard_price,
          source: 'STANDARD_PRICE'
        });
      } else {
        costMap.set(code, { cost: 0, source: 'NONE' });
      }
    });
    
    // 9. Estadísticas
    console.log('\n📊 9. ESTADÍSTICAS FINALES');
    console.log('='.repeat(80));
    
    const stats = {
      SUPPLIERINFO: 0,
      STANDARD_PRICE: 0,
      NOT_FOUND: 0,
      NONE: 0
    };
    
    costMap.forEach(result => {
      stats[result.source] = (stats[result.source] || 0) + 1;
    });
    
    console.log(`\n📈 Distribución:`);
    console.log(`   SUPPLIERINFO: ${stats.SUPPLIERINFO.toLocaleString()}`);
    console.log(`   STANDARD_PRICE: ${stats.STANDARD_PRICE.toLocaleString()}`);
    console.log(`   NOT_FOUND: ${stats.NOT_FOUND.toLocaleString()}`);
    console.log(`   NONE: ${stats.NONE.toLocaleString()}`);
    
    // 10. Exportar mapa de costes
    console.log('\n💾 10. Exportando mapa de costes...');
    const costMapObj = {};
    costMap.forEach((value, key) => {
      costMapObj[key] = value;
    });
    
    const exportFile = path.join(__dirname, 'exports', `costes_variantes_${Date.now()}.json`);
    await fs.writeFile(exportFile, JSON.stringify(costMapObj, null, 2), 'utf-8');
    console.log(`   ✅ Exportado a: ${exportFile}`);
    
    console.log('\n✅ Proceso completado!\n');
    
    return costMapObj;
    
  } catch (error) {
    console.error('\n❌ Error:', error);
    console.error(error.stack);
    throw error;
  }
}

obtenerCostesOptimizado().catch(error => {
  console.error('Error fatal:', error);
  process.exit(1);
});

