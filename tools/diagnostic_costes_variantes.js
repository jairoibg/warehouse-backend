/**
 * Script detallado para diagnosticar y obtener costes de todas las variantes
 * Revisa línea por línea cada variante y obtiene su coste desde Odoo
 */

import 'dotenv/config';
import { odooAuth, odooExecute } from './src/services/odooService.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCATIONS_FILE = path.join(__dirname, 'data', 'locations.json');

async function diagnosticarCostes() {
  console.log('🔍 DIAGNÓSTICO DETALLADO DE COSTES DE VARIANTES\n');
  console.log('='.repeat(80));
  
  try {
    // 1. Cargar datos locales
    console.log('\n📂 1. Cargando datos locales...');
    const rawData = await fs.readFile(LOCATIONS_FILE, 'utf-8');
    const locations = JSON.parse(rawData);
    
    // 2. Extraer todas las variantes únicas
    console.log('\n📊 2. Extrayendo variantes únicas...');
    const variantMap = new Map(); // productCode -> { productIds: Set, packages: [] }
    
    locations.forEach(loc => {
      if (!loc.packages || loc.packages.length === 0) return;
      
      loc.packages.forEach(pkg => {
        const productCode = pkg.productCode || pkg.surtido || 'SIN_REF';
        const cost = pkg.cost || 0;
        const qty = pkg.qty || 0;
        
        if (!variantMap.has(productCode)) {
          variantMap.set(productCode, {
            productCode,
            hasCost: cost > 0,
            costValue: cost,
            totalQty: 0,
            packageCount: 0,
            locations: new Set(),
            // Buscaremos el product_id real más adelante
          });
        }
        
        const variant = variantMap.get(productCode);
        variant.totalQty += qty;
        variant.packageCount += 1;
        variant.locations.add(loc.id);
        
        if (cost > 0 && !variant.hasCost) {
          variant.hasCost = true;
          variant.costValue = cost;
        }
      });
    });
    
    const variants = Array.from(variantMap.values());
    const variantsWithCost = variants.filter(v => v.hasCost);
    const variantsWithoutCost = variants.filter(v => !v.hasCost);
    
    console.log(`   Total variantes: ${variants.length.toLocaleString()}`);
    console.log(`   Con coste: ${variantsWithCost.length.toLocaleString()}`);
    console.log(`   Sin coste: ${variantsWithoutCost.length.toLocaleString()}`);
    console.log(`   Porcentaje sin coste: ${((variantsWithoutCost.length / variants.length) * 100).toFixed(2)}%`);
    
    // 3. Conectar a Odoo
    console.log('\n🔌 3. Conectando a Odoo...');
    const uid = await odooAuth();
    console.log(`   ✅ Conectado (UID: ${uid})`);
    
    // 4. Buscar todas las variantes en Odoo por código
    console.log('\n🔍 4. Buscando variantes en Odoo...');
    console.log(`   Buscando ${variants.length} variantes...`);
    
    const productCodes = variants.map(v => v.productCode);
    const productIdsMap = new Map(); // productCode -> product_id
    
    // Buscar en lotes más pequeños de 50 para evitar timeout
    const BATCH_SIZE = 50;
    let processed = 0;
    for (let i = 0; i < productCodes.length; i += BATCH_SIZE) {
      const batch = productCodes.slice(i, i + BATCH_SIZE);
      processed += batch.length;
      process.stdout.write(`\r   Procesando ${processed}/${productCodes.length} variantes (${Math.floor((processed/productCodes.length)*100)}%)...`);
      
      try {
        // Usar search_read con dominio 'in' - más eficiente
        const products = await odooExecute(
          'product.product',
          'search_read',
          [[['default_code', 'in', batch]]],
          { fields: ['id', 'default_code', 'product_tmpl_id', 'standard_price'], limit: BATCH_SIZE }
        );
        
        products.forEach(p => {
          const code = p.default_code || '';
          if (code && !productIdsMap.has(code)) {
            productIdsMap.set(code, {
              product_id: p.id,
              product_tmpl_id: p.product_tmpl_id ? (Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id) : null,
              standard_price: p.standard_price || 0
            });
          }
        });
        
        // Pequeña pausa para no sobrecargar Odoo
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`\n   ❌ Error en lote ${Math.floor(i/BATCH_SIZE) + 1}:`, error.message);
        // Continuar con el siguiente lote
      }
    }
    
    console.log(`\n   ✅ Encontrados ${productIdsMap.size} productos en Odoo`);
    
    // 5. Obtener costes desde supplierinfo
    console.log('\n💰 5. Obteniendo costes desde product.supplierinfo...');
    
    const templateIds = [...new Set(Array.from(productIdsMap.values()).map(p => p.product_tmpl_id).filter(Boolean))];
    console.log(`   Buscando supplierinfo para ${templateIds.length} templates...`);
    
    const supplierInfoMap = new Map(); // product_tmpl_id -> { price, currency_id }
    
    if (templateIds.length > 0) {
      // Buscar en lotes más pequeños
      const TEMPLATE_BATCH_SIZE = 50;
      let processedTemplates = 0;
      for (let i = 0; i < templateIds.length; i += TEMPLATE_BATCH_SIZE) {
        const batch = templateIds.slice(i, i + TEMPLATE_BATCH_SIZE);
        processedTemplates += batch.length;
        process.stdout.write(`\r   Procesando templates ${processedTemplates}/${templateIds.length} (${Math.floor((processedTemplates/templateIds.length)*100)}%)...`);
        
        try {
          const supplierInfos = await odooExecute(
            'product.supplierinfo',
            'search_read',
            [[['product_tmpl_id', 'in', batch]]],
            { fields: ['product_tmpl_id', 'price', 'currency_id', 'name', 'sequence'], limit: TEMPLATE_BATCH_SIZE * 5 } // Permitir múltiples supplierinfo por template
          );
          
          supplierInfos.forEach(si => {
            const tmplId = si.product_tmpl_id ? (Array.isArray(si.product_tmpl_id) ? si.product_tmpl_id[0] : si.product_tmpl_id) : null;
            if (tmplId && si.price !== undefined && si.price !== null && si.price > 0) {
              const sequence = si.sequence || 0;
              
              if (!supplierInfoMap.has(tmplId)) {
                supplierInfoMap.set(tmplId, {
                  price: si.price,
                  currency_id: si.currency_id ? (Array.isArray(si.currency_id) ? si.currency_id[1] : si.currency_id) : 'EUR',
                  sequence: sequence
                });
              } else {
                // Si ya existe, tomar el de menor sequence (más prioritario)
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
          
          // Pequeña pausa para no sobrecargar Odoo
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`\n   ❌ Error en lote de templates ${Math.floor(i/TEMPLATE_BATCH_SIZE) + 1}:`, error.message);
          // Continuar con el siguiente lote
        }
      }
      
      console.log(`\n   ✅ Encontrado supplierinfo para ${supplierInfoMap.size} templates`);
    }
    
    // 6. Obtener tasas de cambio
    console.log('\n💱 6. Obteniendo tasas de cambio...');
    const currencies = [...new Set(Array.from(supplierInfoMap.values()).map(s => s.currency_id).filter(c => c && c !== 'EUR'))];
    console.log(`   Monedas encontradas: ${currencies.length > 0 ? currencies.join(', ') : 'Ninguna (solo EUR)'}`);
    
    const currencyRates = { 'EUR': 1.0 };
    for (const curr of currencies) {
      try {
        const currencyRecords = await odooExecute(
          'res.currency',
          'search_read',
          [[['name', '=', curr]]],
          { fields: ['id', 'name'] }
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
            console.log(`   ${curr}: ${rates[0].rate}`);
          } else {
            currencyRates[curr] = 1.0;
            console.log(`   ${curr}: No se encontró tasa, usando 1.0`);
          }
        }
      } catch (error) {
        console.warn(`   ⚠️  Error obteniendo tasa para ${curr}:`, error.message);
        currencyRates[curr] = 1.0;
      }
    }
    
    // 7. Mapear costes finales
    console.log('\n📋 7. Mapeando costes finales...');
    const costResults = new Map(); // productCode -> { cost, source, currency, rate }
    
    variants.forEach(variant => {
      const productData = productIdsMap.get(variant.productCode);
      
      if (!productData) {
        costResults.set(variant.productCode, {
          cost: 0,
          source: 'NOT_FOUND',
          message: 'Producto no encontrado en Odoo'
        });
        return;
      }
      
      const tmplId = productData.product_tmpl_id;
      const supplierInfo = tmplId ? supplierInfoMap.get(tmplId) : null;
      
      if (supplierInfo) {
        const currency = supplierInfo.currency_id || 'EUR';
        const rate = currencyRates[currency] || 1.0;
        const cost = supplierInfo.price * rate;
        
        costResults.set(variant.productCode, {
          cost: cost,
          source: 'SUPPLIERINFO',
          currency: currency,
          originalPrice: supplierInfo.price,
          rate: rate,
          product_id: productData.product_id,
          product_tmpl_id: tmplId
        });
      } else if (productData.standard_price > 0) {
        costResults.set(variant.productCode, {
          cost: productData.standard_price,
          source: 'STANDARD_PRICE',
          product_id: productData.product_id,
          product_tmpl_id: tmplId
        });
      } else {
        costResults.set(variant.productCode, {
          cost: 0,
          source: 'NONE',
          message: 'Sin supplierinfo ni standard_price',
          product_id: productData.product_id,
          product_tmpl_id: tmplId
        });
      }
    });
    
    // 8. Estadísticas finales
    console.log('\n📊 8. ESTADÍSTICAS FINALES');
    console.log('='.repeat(80));
    
    const bySource = {
      SUPPLIERINFO: 0,
      STANDARD_PRICE: 0,
      NOT_FOUND: 0,
      NONE: 0
    };
    
    let totalCost = 0;
    costResults.forEach((result, code) => {
      bySource[result.source] = (bySource[result.source] || 0) + 1;
      if (result.cost > 0) {
        const variant = variantMap.get(code);
        if (variant) {
          totalCost += result.cost * variant.totalQty;
        }
      }
    });
    
    console.log(`\n📈 Distribución por fuente de coste:`);
    console.log(`   SUPPLIERINFO: ${bySource.SUPPLIERINFO.toLocaleString()} variantes`);
    console.log(`   STANDARD_PRICE: ${bySource.STANDARD_PRICE.toLocaleString()} variantes`);
    console.log(`   NOT_FOUND: ${bySource.NOT_FOUND.toLocaleString()} variantes (no encontradas en Odoo)`);
    console.log(`   NONE: ${bySource.NONE.toLocaleString()} variantes (sin coste)`);
    
    console.log(`\n💰 Coste total calculado: €${totalCost.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    
    // 9. Exportar resultados detallados
    console.log('\n💾 9. Exportando resultados detallados...');
    
    const reportData = variants.map(variant => {
      const result = costResults.get(variant.productCode) || { cost: 0, source: 'UNKNOWN' };
      const productData = productIdsMap.get(variant.productCode);
      
      return {
        productCode: variant.productCode,
        product_id: productData?.product_id || null,
        product_tmpl_id: productData?.product_tmpl_id || null,
        cost: result.cost,
        source: result.source,
        currency: result.currency || 'EUR',
        originalPrice: result.originalPrice || null,
        rate: result.rate || 1.0,
        totalQty: variant.totalQty,
        packageCount: variant.packageCount,
        locationCount: variant.locations.size,
        totalCost: result.cost * variant.totalQty,
        message: result.message || null
      };
    }).sort((a, b) => b.totalCost - a.totalCost);
    
    const reportFile = path.join(__dirname, 'exports', `diagnostic_costes_${Date.now()}.json`);
    await fs.writeFile(reportFile, JSON.stringify(reportData, null, 2), 'utf-8');
    console.log(`   ✅ Exportado a: ${reportFile}`);
    
    // 10. Mostrar ejemplos de problemas
    console.log('\n⚠️  10. EJEMPLOS DE VARIANTES SIN COSTE');
    console.log('='.repeat(80));
    
    const withoutCost = reportData.filter(r => r.cost === 0).slice(0, 20);
    console.log(`\nMostrando primeros ${withoutCost.length} de ${reportData.filter(r => r.cost === 0).length} variantes sin coste:\n`);
    
    withoutCost.forEach((r, idx) => {
      console.log(`${idx + 1}. ${r.productCode}`);
      console.log(`   Source: ${r.source}`);
      console.log(`   Product ID: ${r.product_id || 'N/A'}`);
      console.log(`   Template ID: ${r.product_tmpl_id || 'N/A'}`);
      console.log(`   Cantidad total: ${r.totalQty}`);
      console.log(`   Paquetes: ${r.packageCount}`);
      if (r.message) console.log(`   Mensaje: ${r.message}`);
      console.log('');
    });
    
    console.log('\n✅ Diagnóstico completado!\n');
    
  } catch (error) {
    console.error('\n❌ Error en diagnóstico:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

diagnosticarCostes();

