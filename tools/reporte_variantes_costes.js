/**
 * Script para generar reporte Excel de variantes con costes
 * Obtiene todas las variantes de productos y sus costes desde Odoo
 */

import 'dotenv/config';
import xmlrpc from 'xmlrpc';
import ExcelJS from 'exceljs';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import fsSync from 'fs';
import { getOdooConfig } from './src/config/odooConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ODOO_CONFIG = getOdooConfig();
const EXPORTS_DIR = path.join(__dirname, 'exports');

// Asegurar directorio de exports
if (!fsSync.existsSync(EXPORTS_DIR)) {
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
}

/**
 * Autenticación en Odoo
 */
function odooAuth() {
  return new Promise((resolve, reject) => {
    const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
    common.methodCall('authenticate', [
      ODOO_CONFIG.db,
      ODOO_CONFIG.username,
      ODOO_CONFIG.password,
      {}
    ], (err, uid) => {
      if (err) return reject(err);
      resolve(uid);
    });
  });
}

/**
 * Ejecuta método en Odoo
 */
function odooExecute(model, method, params) {
  return new Promise((resolve, reject) => {
    odooAuth().then(uid => {
      const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
      models.methodCall('execute_kw', [
        ODOO_CONFIG.db,
        uid,
        ODOO_CONFIG.password,
        model,
        method,
        params
      ], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    }).catch(reject);
  });
}

/**
 * Obtiene tasa de cambio de una moneda a EUR
 */
async function getCurrencyRate(uid, currencyCode) {
  if (!currencyCode || currencyCode === 'EUR') return 1.0;
  
  try {
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    return new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        ODOO_CONFIG.db,
        uid,
        ODOO_CONFIG.password,
        'res.currency',
        'search_read',
        [[['name', '=', currencyCode]]],
        { fields: ['name', 'rate'] }
      ], (err, currencies) => {
        if (err || !currencies || currencies.length === 0) {
          console.warn(`⚠️  No se encontró tasa para ${currencyCode}, usando 1.0`);
          resolve(1.0);
        } else {
          const rate = currencies[0].rate || 1.0;
          console.log(`💱 Tasa de cambio ${currencyCode} → EUR: ${rate}`);
          resolve(rate);
        }
      });
    });
  } catch (error) {
    console.warn(`⚠️  Error obteniendo tasa para ${currencyCode}:`, error.message);
    return 1.0;
  }
}

/**
 * Obtiene stock total de una variante desde locations.json
 */
async function getStockForProduct(productCode, locations) {
  let totalQty = 0;
  let totalValue = 0;
  
  locations.forEach(loc => {
    if (loc.packages) {
      loc.packages.forEach(pkg => {
        if (pkg.productCode === productCode) {
          totalQty += pkg.qty || 0;
          totalValue += (pkg.qty || 0) * (pkg.cost || 0);
        }
      });
    }
  });
  
  return { totalQty, totalValue };
}

/**
 * Función principal
 */
async function generateVariantsReport() {
  try {
    console.log('📊 Generando reporte de variantes con costes...\n');
    
    const uid = await odooAuth();
    console.log('✅ Autenticado en Odoo\n');
    
    // 1. Obtener todas las variantes de productos activos
    console.log('📦 Obteniendo todas las variantes de productos...');
    const productIds = await odooExecute('product.product', 'search', [
      [['active', '=', true], ['type', '=', 'product']]
    ]);
    console.log(`   Encontradas ${productIds.length} variantes\n`);
    
    // 2. Obtener detalles de productos en lotes
    console.log('📋 Obteniendo detalles de productos...');
    const BATCH_SIZE = 2000;
    let allProducts = [];
    
    for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
      const batch = productIds.slice(i, i + BATCH_SIZE);
      const products = await new Promise((resolve, reject) => {
        odooAuth().then(uid => {
          const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
          models.methodCall('execute_kw', [
            ODOO_CONFIG.db,
            uid,
            ODOO_CONFIG.password,
            'product.product',
            'read',
            [batch],
            {
              fields: [
                'id',
                'name',
                'default_code',
                'standard_price',
                'currency_id',
                'categ_id',
                'barcode'
              ]
            }
          ], (err, result) => {
            if (err) return reject(err);
            resolve(result);
          });
        }).catch(reject);
      });
      allProducts = allProducts.concat(products);
      process.stdout.write(`\r   Procesadas ${Math.min(i + BATCH_SIZE, productIds.length)}/${productIds.length} variantes`);
    }
    console.log('\n   ✅ Productos obtenidos\n');
    
    // 3. Obtener tasas de cambio para monedas
    console.log('💱 Obteniendo tasas de cambio...');
    const currencies = [...new Set(allProducts.map(p => p.currency_id ? p.currency_id[1] : 'EUR'))];
    const currencyRates = {};
    
    for (const currencyCode of currencies) {
      if (currencyCode === 'EUR') {
        currencyRates[currencyCode] = 1.0;
      } else {
        currencyRates[currencyCode] = await getCurrencyRate(uid, currencyCode);
      }
    }
    console.log(`   Monedas encontradas: ${Object.keys(currencyRates).join(', ')}\n`);
    
    // 4. Cargar locations.json para calcular stock
    console.log('📦 Cargando stock desde locations.json...');
    const locationsPath = path.join(__dirname, 'data', 'locations.json');
    const locationsData = await fs.readFile(locationsPath, 'utf8');
    const locations = JSON.parse(locationsData);
    console.log(`   Ubicaciones cargadas: ${locations.length}\n`);
    
    // 5. Crear mapa de stock por código de producto
    const stockMap = {};
    locations.forEach(loc => {
      if (loc.packages) {
        loc.packages.forEach(pkg => {
          const code = pkg.productCode;
          if (code && code !== 'SIN_REF') {
            if (!stockMap[code]) {
              stockMap[code] = { totalQty: 0, totalValue: 0, packages: 0 };
            }
            stockMap[code].totalQty += pkg.qty || 0;
            stockMap[code].totalValue += (pkg.qty || 0) * (pkg.cost || 0);
            stockMap[code].packages += 1;
          }
        });
      }
    });
    
    // 6. Preparar datos para Excel
    console.log('📊 Preparando datos para Excel...');
    const reportData = allProducts.map(product => {
      const code = product.default_code || '';
      const currency = product.currency_id ? product.currency_id[1] : 'EUR';
      const costOriginal = product.standard_price || 0;
      const rate = currencyRates[currency] || 1.0;
      const costEUR = costOriginal * rate;
      
      const stock = stockMap[code] || { totalQty: 0, totalValue: 0, packages: 0 };
      const totalValueEUR = costEUR * stock.totalQty;
      
      return {
        id: product.id,
        codigo: code,
        nombre: product.name || '',
        coste_original: costOriginal,
        moneda: currency,
        tasa_cambio: rate,
        coste_eur: costEUR,
        stock_total: stock.totalQty,
        valor_total_eur: totalValueEUR,
        num_paquetes: stock.packages,
        categoria: product.categ_id ? product.categ_id[1] : 'N/A',
        barcode: product.barcode || ''
      };
    });
    
    // Ordenar por valor total descendente
    reportData.sort((a, b) => b.valor_total_eur - a.valor_total_eur);
    
    console.log(`   Datos preparados: ${reportData.length} variantes\n`);
    
    // 7. Generar Excel
    console.log('📄 Generando archivo Excel...');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Variantes y Costes');
    
    // Encabezados
    worksheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Código', key: 'codigo', width: 25 },
      { header: 'Nombre', key: 'nombre', width: 50 },
      { header: 'Coste Original', key: 'coste_original', width: 15 },
      { header: 'Moneda', key: 'moneda', width: 10 },
      { header: 'Tasa Cambio', key: 'tasa_cambio', width: 12 },
      { header: 'Coste (EUR)', key: 'coste_eur', width: 15 },
      { header: 'Stock Total', key: 'stock_total', width: 12 },
      { header: 'Valor Total (EUR)', key: 'valor_total_eur', width: 18 },
      { header: 'Nº Paquetes', key: 'num_paquetes', width: 12 },
      { header: 'Categoría', key: 'categoria', width: 30 },
      { header: 'Código Barras', key: 'barcode', width: 20 }
    ];
    
    // Estilo de encabezado
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    
    // Añadir datos
    reportData.forEach(row => {
      worksheet.addRow(row);
    });
    
    // Formato numérico para columnas de coste y valor
    worksheet.getColumn('coste_original').numFmt = '#,##0.00';
    worksheet.getColumn('tasa_cambio').numFmt = '#,##0.0000';
    worksheet.getColumn('coste_eur').numFmt = '#,##0.00';
    worksheet.getColumn('valor_total_eur').numFmt = '#,##0.00';
    
    // Resaltar filas con coste 0
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        const costeEUR = row.getCell('coste_eur').value;
        if (costeEUR === 0 || costeEUR === null) {
          row.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFE6E6' }
          };
        }
      }
    });
    
    // Añadir fila de totales
    const totalRow = worksheet.addRow({
      id: 'TOTAL',
      codigo: '',
      nombre: 'TOTALES',
      coste_original: '',
      moneda: '',
      tasa_cambio: '',
      coste_eur: '',
      stock_total: reportData.reduce((sum, r) => sum + r.stock_total, 0),
      valor_total_eur: reportData.reduce((sum, r) => sum + r.valor_total_eur, 0),
      num_paquetes: '',
      categoria: '',
      barcode: ''
    });
    totalRow.font = { bold: true };
    totalRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' }
    };
    totalRow.getCell('valor_total_eur').numFmt = '#,##0.00';
    
    // Guardar archivo
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `reporte_variantes_costes_${timestamp}.xlsx`;
    const filepath = path.join(EXPORTS_DIR, filename);
    
    await workbook.xlsx.writeFile(filepath);
    
    console.log(`✅ Reporte generado: ${filename}`);
    console.log(`📁 Ubicación: ${filepath}\n`);
    
    // Estadísticas
    const withCost = reportData.filter(r => r.coste_eur > 0).length;
    const withoutCost = reportData.filter(r => r.coste_eur === 0).length;
    const totalValue = reportData.reduce((sum, r) => sum + r.valor_total_eur, 0);
    
    console.log('📊 ESTADÍSTICAS:');
    console.log(`   Variantes con coste: ${withCost}`);
    console.log(`   Variantes sin coste: ${withoutCost}`);
    console.log(`   Valor total stock: €${totalValue.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`   Monedas encontradas: ${Object.keys(currencyRates).join(', ')}\n`);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Ejecutar
generateVariantsReport().then(() => {
  console.log('✅ Proceso completado');
  process.exit(0);
}).catch(error => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});

