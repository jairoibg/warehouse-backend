import 'dotenv/config';
import xmlrpc from 'xmlrpc';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// --- CONFIGURACIÓN ---
const ODOO_CONFIG = {
  url: process.env.ODOO_URL,
  db: process.env.ODOO_DB,
  username: process.env.ODOO_USERNAME,
  password: process.env.ODOO_PASSWORD,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCATIONS_FILE = path.join(__dirname, 'data', 'locations.json');
const REPORT_FILE = path.join(__dirname, 'data', 'audit_report.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- HELPERS DE INGENIERÍA ---
function findLocationID(fullName) {
  if (!fullName) return "UNKNOWN";
  const match = fullName.match(/CLA-\d{3}-\d{2}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parts = fullName.split('/');
  return parts[parts.length - 1].trim();
}

// Extraer altura del rack (asumiendo formato CLA-XXX-XX-ALTURA-XX)
function getSlotHeight(locId) {
  const parts = locId.split('-');
  // Ajusta este índice según tu nomenclatura real. 
  // Ej: CLA-009-05-03-03 -> El 4º elemento suele ser altura/nivel
  if (parts.length >= 5) return parseInt(parts[3]) || 1; 
  return 1;
}

function detectBrand(productCode, productName) {
  const s = (productCode + " " + productName).toUpperCase();
  if (s.includes("DF") || s.includes("BLACK") || s.includes("D.FRANKLIN")) return "BLACK";
  if (s.includes("KA") || s.includes("WHITE") || s.includes("KALK")) return "WHITE";
  if (s.includes("CO") || s.includes("GOLD") || s.includes("CONGUITOS") || s.includes("BREAK")) return "GOLD";
  return "GENERIC";
}

// --- ODOO CORE ---
async function odooExecute(method, model, operation, params, options = {}) {
  const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });

  const uid = await new Promise((resolve, reject) => {
    common.methodCall('authenticate', [
      ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
    ], (err, res) => err ? reject(err) : resolve(res));
  });

  return new Promise((resolve, reject) => {
    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
      model, operation, params, options
    ], (err, res) => err ? reject(err) : resolve(res));
  });
}

async function fetchAllRecords(model, domain, fields) {
  let allRecords = [];
  let offset = 0;
  const LIMIT = 2000;
  let hasMore = true;

  process.stdout.write(` 📡  Descargando ${model}... `);

  while (hasMore) {
    try {
      const batch = await odooExecute('execute_kw', model, 'search_read', [domain], {
        fields, offset, limit: LIMIT
      });
      allRecords = allRecords.concat(batch);
      offset += LIMIT;
      process.stdout.write('.');
      if (batch.length < LIMIT) hasMore = false;
      await sleep(50);
    } catch (e) {
      console.error(`\n ❌ Error batch ${offset}:`, e.message);
      hasMore = false;
    }
  }
  console.log(` ✅ (${allRecords.length})`);
  return allRecords;
}

// --- CÁLCULO ABC FINANCIERO (365 DÍAS) ---
async function calculateRichPareto(productIds) {
  console.log(` 🧮  Auditando Rendimiento Financiero (365 días) de ${productIds.length} productos...`);
  
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const dateStr = oneYearAgo.toISOString().split('T')[0];

  const sales = await fetchAllRecords('sale.order.line', 
    [
      ['product_id', 'in', productIds], 
      ['order_id.date_order', '>=', dateStr],
      ['state', 'in', ['sale', 'done']]
    ],
    ['product_id', 'price_total', 'product_uom_qty']
  );

  const stats = {};
  let totalRevenueGlobal = 0;

  // 1. Agregación
  sales.forEach(s => {
    const pid = s.product_id[0];
    const val = s.price_total || 0;
    const qty = s.product_uom_qty || 0;
    
    if (!stats[pid]) stats[pid] = { revenue: 0, sales_count: 0, units_sold: 0 };
    
    stats[pid].revenue += val;
    stats[pid].units_sold += qty;
    stats[pid].sales_count += 1; // Contamos líneas de pedido como proxies de frecuencia
    totalRevenueGlobal += val;
  });

  // 2. Ranking y Percentiles
  const ranked = productIds.map(id => ({ 
    id, 
    ...stats[id] || { revenue: 0, sales_count: 0, units_sold: 0 } 
  })).sort((a, b) => b.revenue - a.revenue);

  const enrichedData = {};
  let accumRevenue = 0;

  ranked.forEach(item => {
    let abc = 'D';
    let explanation = "Sin ventas en 365 días.";
    
    if (item.revenue > 0) {
      accumRevenue += item.revenue;
      const revenuePct = (accumRevenue / totalRevenueGlobal) * 100;
      const itemShare = (item.revenue / totalRevenueGlobal) * 100; // Cuota individual

      if (revenuePct <= 80) abc = 'A';
      else if (revenuePct <= 95) abc = 'B';
      else abc = 'C';

      explanation = `Generó €${item.revenue.toFixed(2)} (${item.sales_count} pedidos). Representa el ${itemShare.toFixed(4)}% del volumen total auditado (€${totalRevenueGlobal.toFixed(0)}).`;
    }

    enrichedData[item.id] = {
      class: abc,
      metrics: {
        revenue365: item.revenue,
        salesOrders365: item.sales_count,
        unitsSold365: item.units_sold,
        globalRevenueShare: totalRevenueGlobal > 0 ? (item.revenue / totalRevenueGlobal) : 0,
        explanation: explanation
      }
    };
  });

  return { data: enrichedData, globalTotal: totalRevenueGlobal };
}

// --- PROCESO PRINCIPAL ---
async function runAudit() {
  console.time("⏱️ Tiempo Total");
  console.log("\n 👮  INICIANDO AUDITORÍA FORENSE DE NEGOCIO");
  console.log(" ==================================================");

  try {
    // 1. Carga Estructura
    const rawMap = await fs.readFile(LOCATIONS_FILE, 'utf8');
    const locations = JSON.parse(rawMap);
    
    // 2. Descarga Stock
    const quants = await fetchAllRecords('stock.quant', 
      [['location_id.usage', '=', 'internal'], ['quantity', '>', 0]],
      ['location_id', 'product_id', 'package_id', 'quantity', 'reserved_quantity', 'in_date']
    );

    // 3. Identificar Productos
    const productIds = [...new Set(quants.map(q => q.product_id[0]))];

    // 4. Descargar ABC Oficial
    const abcRecords = await fetchAllRecords('abc.classification.product.level',
      [['product_id', 'in', productIds]],
      ['product_id', 'level_id']
    );
    const officialAbcMap = {};
    abcRecords.forEach(x => officialAbcMap[x.product_id[0]] = x.level_id ? x.level_id[1] : null);

    // 5. ANÁLISIS FINANCIERO PROFUNDO (Para los Huérfanos)
    const orphans = productIds.filter(id => !officialAbcMap[id]);
    let calculatedData = { data: {}, globalTotal: 0 };
    
    if (orphans.length > 0) {
      calculatedData = await calculateRichPareto(orphans);
    }

    // 6. Metadatos Producto
    const products = await fetchAllRecords('product.product',
      [['id', 'in', productIds]],
      ['name', 'default_code', 'standard_price', 'sale_season_id']
    );

    const productMeta = {};
    products.forEach(p => {
      const official = officialAbcMap[p.id];
      const calcInfo = calculatedData.data[p.id];
      
      let finalAbc = 'D';
      let source = 'UNKNOWN';
      let metrics = null;

      if (official) {
        finalAbc = official;
        source = 'OFFICIAL';
        // NOTA: Aquí podríamos cruzar también ventas para validar el oficial, pero respetamos Odoo.
      } else if (calcInfo) {
        finalAbc = calcInfo.class;
        source = 'CALCULATED_365';
        metrics = calcInfo.metrics;
      }

      productMeta[p.id] = {
        code: p.default_code || "SIN_REF",
        name: p.name,
        cost: p.standard_price || 0,
        season: (p.sale_season_id && Array.isArray(p.sale_season_id)) ? p.sale_season_id[1] : 'N/A',
        abcClass: finalAbc,
        abcSource: source,
        financials: metrics // ¡AQUÍ ESTÁ EL ORO PARA LA IA!
      };
    });

    // 7. Reconstrucción Física & Lógica
    console.log("\n 🔨  Reconstruyendo realidad física con lógica financiera...");
    
    const stockByLocation = {};

    quants.forEach(q => {
      const locId = findLocationID(q.location_id[1]);
      if (!stockByLocation[locId]) stockByLocation[locId] = [];

      const meta = productMeta[q.product_id[0]];
      const daysOld = q.in_date ? Math.floor((new Date() - new Date(q.in_date)) / (1000 * 60 * 60 * 24)) : 0;

      stockByLocation[locId].push({
        packageId: q.package_id ? q.package_id[1] : "SUELTO",
        productCode: meta.code,
        surtido: meta.name,
        qty: q.quantity,
        reservedQty: q.reserved_quantity,
        
        // Datos Estratégicos
        abcClass: meta.abcClass,
        abcSource: meta.abcSource,
        financials: meta.financials, // Pasamos los datos financieros al frontend/IA
        
        season: meta.season,
        daysOld: daysOld,
        cost: meta.cost,
        value: (meta.cost * q.quantity) // Valoración stock inmovilizado
      });
    });

    // 8. Escritura Final con Lógica de Negocio
    let occupiedCount = 0;
    let cleanedCount = 0;

    const finalLocations = locations.map(loc => {
      const realStock = stockByLocation[loc.id];
      const heightLevel = getSlotHeight(loc.id);

      if (realStock && realStock.length > 0) {
        occupiedCount++;
        
        const totalStock = realStock.reduce((sum, i) => sum + i.qty, 0);
        const totalValue = realStock.reduce((sum, i) => sum + i.value, 0);
        const brand = detectBrand(realStock[0].productCode, realStock[0].surtido);

        return {
          ...loc,
          status: 'OCCUPIED',
          brand: brand,
          totalStock: totalStock,
          totalValue: totalValue, // Dato para CFO
          slotHeight: heightLevel, // Dato para Logística
          packages: realStock,
          sinDatos: false,
          lastAudit: new Date().toISOString()
        };
      } else {
        if (loc.status === 'OCCUPIED') cleanedCount++;
        return {
          ...loc,
          status: 'FREE',
          brand: loc.id.includes('BD') ? 'BLACK' : loc.id.includes('GD') ? 'GOLD' : 'GENERIC',
          totalStock: 0,
          totalValue: 0,
          slotHeight: heightLevel,
          packages: [],
          sinDatos: false,
          lastAudit: new Date().toISOString()
        };
      }
    });

    // 9. Reporte Ejecutivo
    const report = {
      date: new Date().toISOString(),
      scope: "STORAGE INTERNAL",
      kpis: {
        total_revenue_audited_365: calculatedData.globalTotal,
        occupied_locations: occupiedCount,
        ghost_locations_cleared: cleanedCount,
        orphans_analyzed: orphans.length
      }
    };

    await fs.writeFile(LOCATIONS_FILE, JSON.stringify(finalLocations, null, 2));
    await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2));

    console.log("\n 🏁  AUDITORÍA FINANCIERA COMPLETADA.");
    console.log(`     Ingresos Analizados (Huérfanos): €${calculatedData.globalTotal.toFixed(0)}`);
    console.log(`     Ubicaciones Actualizadas: ${occupiedCount}`);
    console.timeEnd("⏱️ Tiempo Total");

  } catch (error) {
    console.error("❌ Error Fatal:", error);
  }
}

runAudit();