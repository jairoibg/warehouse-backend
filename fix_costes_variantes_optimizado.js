/**
 * Script optimizado para obtener costes de variantes
 * Versión más eficiente que procesa en lotes pequeños para evitar timeouts
 */

import 'dotenv/config';
import { odooAuth, odooExecute } from './src/services/odooService.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCATIONS_FILE = path.join(__dirname, 'data', 'locations.json');

async function obtenerCostesVariantes() {
  console.log('🔍 OBTENCIÓN DETALLADA DE COSTES DE VARIANTES\n');
  console.log('='.repeat(80));
  
  try {
    // 1. Cargar datos locales
    console.log('\n📂 1. Cargando datos locales...');
    const rawData = await fs.readFile(LOCATIONS_FILE, 'utf-8');
    const locations = JSON.parse(rawData);
    
    // 2. Extraer todas las variantes únicas
    console.log('\n📊 2. Extrayendo variantes únicas...');
    const variantSet = new Set();
    locations.forEach(loc => {
      if (!loc.packages || loc.packages.length === 0) return;
      loc.packages.forEach(pkg => {
        const productCode = pkg.productCode || pkg.surtido || null;
        if (productCode) variantSet.add(productCode);
      });
    });
    
    const productCodes = Array.from(variantSet);
    console.log(`   Total variantes únicas: ${productCodes.length.toLocaleString()}`);
    
    // 3. Conectar a Odoo
    console.log('\n🔌 3. Conectando a Odoo...');
    const uid = await odooAuth();
    console.log(`   ✅ Conectado (UID: ${uid})`);
    
    // 4. Buscar productos en Odoo - PROCESO OPTIMIZADO
    console.log('\n🔍 4. Buscando productos en Odoo (proceso optimizado)...');
    const productIdsMap = new Map(); // productCode -> { product_id, product_tmpl_id, standard_price }
    
    const BATCH_SIZE = 50; // Lotes pequeños para evitar timeout
    const totalBatches = Math.ceil(productCodes.length / BATCH_SIZE);
    
    for (let i = 0; i < productCodes.length; i += BATCH_SIZE) {
      const batch = productCodes.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i/BATCH_SIZE) + 1;
      
      process.stdout.write(`\r   Lote ${batchNum}/${totalBatches} (${((i/productCodes.length)*100).toFixed(1)}%)...`);
      
      try {
        const products = await odooExecute(
          'product.product',
          'search_read',
          [[['default_code', 'in', batch]]],
          { fields: ['id', 'default_code', 'product_tmpl_id', 'standard_price'], limit: BATCH_SIZE }
        );
        
        products.forEach(p => {
          const code = p.default_code || '';
          if (code) {
            productIdsMap.set(code, {
              product_id: p.id,
              product_tmpl_id: p.product_tmpl_id ? (Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id) : null,
              standard_price: p.standard_price || 0
            });
          }
        });
        
        // Pequeña pausa para no sobrecargar
        if (i + BATCH_SIZE < productCodes.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (error) {
        console.error(`\n   ⚠️  Error en lote ${batchNum}, continuando...`);
      }
    }
    
    console.log(`\n   ✅ Encontrados ${productIdsMap.size} productos en Odoo (${((productIdsMap.size/productCodes.length)*100).toFixed(1)}%)`);
    
    // 5. Obtener supplierinfo - PROCESO OPTIMIZADO
    console.log('\n💰 5. Obteniendo costes desde supplierinfo (proceso optimizado)...');
    
    const templateIds = [...new Set(Array.from(productIdsMap.values()).map(p => p.product_tmpl_id).filter(Boolean))];
    console.log(`   Templates únicos: ${templateIds.length.toLocaleString()}`);
    
    const supplierInfoMap = new Map(); // product_tmpl_id -> { price, currency_id, sequence }
    
    if (templateIds.length > 0) {
      const TEMPLATE_BATCH_SIZE = 50;
      const totalTemplateBatches = Math.ceil(templateIds.length / TEMPLATE_BATCH_SIZE);
      
      for (let i = 0; i < templateIds.length; i += TEMPLATE_BATCH_SIZE) {
        const batch = templateIds.slice(i, i + TEMPLATE_BATCH_SIZE);
        const batchNum = Math.floor(i/TEMPLATE_BATCH_SIZE) + 1;
        
        process.stdout.write(`\r   Templates ${batchNum}/${totalTemplateBatches} (${((i/templateIds.length)*100).toFixed(1)}%)...`);
        
        try {
          const supplierInfos = await odooExecute(
            'product.supplierinfo',
            'search_read',
            [[['product_tmpl_id', 'in', batch]]],
            { fields: ['product_tmpl_id', 'price', 'currency_id', 'name', 'sequence'], limit: 1000 }
          );
          
          supplierInfos.forEach(si => {
            const tmplId = si.product_tmpl_id ? (Array.isArray(si.product_tmpl_id) ? si.product_tmpl_id[0] : si.product_tmpl_id) : null;
            if (tmplId && si.price !== undefined && si.price !== null) {
              const sequence = si.sequence || 0;
              
              if (!supplierInfoMap.has(tmplId)) {
                supplierInfoMap.set(tmplId, {
                  price: si.price,
                  currency_id: si.currency_id ? (Array.isArray(si.currency_id) ? si.currency_id[1] : si.currency_id) : 'EUR',
                  sequence: sequence
                });
              } else {
                // Tomar el de menor sequence (más prioritario)
                const existing = supplierInfoMap.get(tmplId);
                if (sequence < existing.sequence) {
                  supplierInfoMap.set(tmplId, {
                    price: si.price,
                    currency_id: si.currency_id ? (Array.isArray(si.currency_id) ? si.currency_id[1] : si.currency_id) : 'EUR',
                    sequence: sequence
                  });
                }
              }
            }
          });
          
          // Pausa entre lotes
          if (i + TEMPLATE_BATCH_SIZE < templateIds.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        } catch (error) {
          console.error(`\n   ⚠️  Error en lote de templates ${batchNum}, continuando...`);
        }
      }
      
      console.log(`\n   ✅ Supplierinfo obtenido para ${supplierInfoMap.size} templates (${((supplierInfoMap.size/templateIds.length)*100).toFixed(1)}%)`);
    }
    
    // 6. Tasas de cambio (solo una vez por moneda)
    console.log('\n💱 6. Obteniendo tasas de cambio...');
    const currencies = [...new Set(Array.from(supplierInfoMap.values()).map(s => s.currency_id).filter(c => c && c !== 'EUR'))];
    console.log(`   Monedas: ${currencies.length > 0 ? currencies.join(', ') : 'Solo EUR'}`);
    
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
          
          currencyRates[curr] = rates.length > 0 && rates[0].rate ? rates[0].rate : 1.0;
        }
      } catch (error) {
        currencyRates[curr] = 1.0;
      }
    }
    
    console.log('   ✅ Tasas obtenidas');
    
    // 7. Crear mapa final de costes
    console.log('\n📋 7. Creando mapa final de costes...');
    const costMap = new Map(); // productCode -> { cost, source, details }
    
    productCodes.forEach(code => {
      const productData = productIdsMap.get(code);
      
      if (!productData) {
        costMap.set(code, { cost: 0, source: 'NOT_FOUND' });
        return;
      }
      
      const tmplId = productData.product_tmpl_id;
      const supplierInfo = tmplId ? supplierInfoMap.get(tmplId) : null;
      
      if (supplierInfo) {
        const currency = supplierInfo.currency_id || 'EUR';
        const rate = currencyRates[currency] || 1.0;
        costMap.set(code, {
          cost: supplierInfo.price * rate,
          source: 'SUPPLIERINFO',
          currency: currency,
          originalPrice: supplierInfo.price,
          rate: rate,
          product_id: productData.product_id,
          product_tmpl_id: tmplId
        });
      } else if (productData.standard_price > 0) {
        costMap.set(code, {
          cost: productData.standard_price,
          source: 'STANDARD_PRICE',
          product_id: productData.product_id,
          product_tmpl_id: tmplId
        });
      } else {
        costMap.set(code, {
          cost: 0,
          source: 'NONE',
          product_id: productData.product_id,
          product_tmpl_id: tmplId
        });
      }
    });
    
    // 8. Estadísticas
    console.log('\n📊 8. ESTADÍSTICAS');
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
    
    console.log(`\nDistribución por fuente:`);
    console.log(`   SUPPLIERINFO: ${stats.SUPPLIERINFO.toLocaleString()} (${((stats.SUPPLIERINFO/productCodes.length)*100).toFixed(1)}%)`);
    console.log(`   STANDARD_PRICE: ${stats.STANDARD_PRICE.toLocaleString()} (${((stats.STANDARD_PRICE/productCodes.length)*100).toFixed(1)}%)`);
    console.log(`   NOT_FOUND: ${stats.NOT_FOUND.toLocaleString()} (${((stats.NOT_FOUND/productCodes.length)*100).toFixed(1)}%)`);
    console.log(`   NONE: ${stats.NONE.toLocaleString()} (${((stats.NONE/productCodes.length)*100).toFixed(1)}%)`);
    
    // 9. Exportar resultados
    console.log('\n💾 9. Exportando resultados...');
    
    const results = productCodes.map(code => ({
      productCode: code,
      ...(costMap.get(code) || { cost: 0, source: 'UNKNOWN' })
    }));
    
    const reportFile = path.join(__dirname, 'exports', `costes_variantes_${Date.now()}.json`);
    await fs.writeFile(reportFile, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`   ✅ Exportado: ${reportFile}`);
    
    // Mostrar resumen
    console.log('\n✅ Proceso completado!\n');
    console.log(`📁 Archivo de resultados: ${reportFile}`);
    console.log(`\n💡 Siguiente paso: Usar estos resultados para actualizar sync_odoo.js`);
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

obtenerCostesVariantes();

