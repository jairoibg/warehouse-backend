import xmlrpc from 'xmlrpc';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// --- CONFIGURACIÓN ODOO ---
const ODOO_CONFIG = {
  url: 'https://professional.illice.com',
  db: 'blackdivision',
  username: 'j.bernabe@illice.com',
  password: '98b68f64a4ee2fd5362f16f3b0427a629877f80f',
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCATIONS_FILE = path.join(__dirname, 'data', 'locations.json');

// ================== INGENIERÍA LOGÍSTICA ==================
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

// --- HELPERS ---
function findLocationID(fullName) {
  if (!fullName) return "UNKNOWN";
  const match = fullName.match(/CLA-\d{3}-\d{2}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parts = fullName.split('/');
  return parts[parts.length - 1].trim();
}

function calculateDaysOld(dateString) {
  if (!dateString) return 0;
  const entryDate = new Date(dateString);
  const today = new Date();
  const diffTime = Math.abs(today.getTime() - entryDate.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// --- ODOO API ---
function odooAuth() {
  return new Promise((resolve, reject) => {
    const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
    common.methodCall('authenticate', [
      ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
    ], (error, uid) => {
      if (error) return reject(error);
      if (!uid) return reject(new Error("Autenticación fallida"));
      resolve(uid);
    });
  });
}

function fetchBatchStock(uid, offset, limit) {
  return new Promise((resolve, reject) => {
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    const fields = ['location_id', 'package_id', 'product_id', 'quantity', 'reserved_quantity', 'in_date', 'product_set_id'];
    const domain = [['location_id.usage', '=', 'internal']];
    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
      'stock.quant', 'search_read', [domain],
      { fields: fields, offset: offset, limit: limit }
    ], (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
  });
}

function fetchProductDetails(uid, productIds) {
  return new Promise((resolve, reject) => {
    if (productIds.length === 0) return resolve([]);
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    const fields = ['name', 'default_code', 'standard_price', 'sale_season_id']; 
    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
      'product.product', 'read', [productIds],
      { fields: fields }
    ], (error, products) => {
      if (error) return reject(error);
      resolve(products);
    });
  });
}

function fetchABCData(uid, productIds) {
  return new Promise((resolve, reject) => {
    if (productIds.length === 0) return resolve([]);
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
      'abc.classification.product.level', 'search_read', 
      [[['product_id', 'in', productIds]]],
      { fields: ['product_id', 'level_id'] }
    ], (error, results) => {
      if (error) { console.error(" ❌  Error ABC:", error); resolve([]); } 
      else resolve(results);
    });
  });
}

// 4. BI: VENTAS REALES (EXPORTADA)
export async function getRealTimeSales(daysBack) {
  try {
    const uid = await odooAuth();
    const date = new Date();
    date.setDate(date.getDate() - daysBack);
    const dateStr = date.toISOString().split('T')[0];
    console.log(` 📉  [ODOO LIVE] Descargando ventas desde ${dateStr}...`);
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    const domain = [['order_id.date_order', '>=', dateStr], ['state', 'in', ['sale', 'done']]];

    return new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
        'sale.order.line', 'search_read', [domain],
        { fields: ['product_id', 'product_uom_qty', 'price_total'] } 
      ], (error, results) => {
        if (error) return reject(error);
        const cleanData = results.filter(r => {
            const name = (r.product_id && r.product_id[1]) ? r.product_id[1].toUpperCase() : "";
            if (name.includes("OUTVIO") || name.includes("TRANSPORT") || name.includes("SHIPPING") || name.includes("ENVIO") || name.includes("DISCOUNT")) return false;
            return true;
        }).map(r => ({ p: r.product_id[1], q: r.product_uom_qty, v: r.price_total }));
        console.log(` ✅  Descargadas ${cleanData.length} líneas de venta limpias.`);
        resolve(cleanData);
      });
    });
  } catch (e) {
    console.error("Error fetching sales:", e);
    return [];
  }
}

// 5. Velocidad Interna
function fetchSalesVelocity(uid, productIds) {
  return new Promise((resolve, reject) => {
    if (productIds.length === 0) return resolve({});
    const date = new Date();
    date.setDate(date.getDate() - 90);
    const dateStr = date.toISOString().split('T')[0];
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });
    const domain = [['product_id', 'in', productIds], ['order_id.date_order', '>=', dateStr], ['state', 'in', ['sale', 'done']]];

    models.methodCall('execute_kw', [
      ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
      'sale.order.line', 'search_read', [domain],
      { fields: ['product_id', 'product_uom_qty'] } 
    ], (error, results) => {
      if (error) { resolve({}); return; }
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
  console.log(" ⏳  Iniciando descarga de stock...");
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

export async function syncWithOdoo() {
  try {
    const rawData = await fs.readFile(LOCATIONS_FILE, 'utf-8');
    let locations = JSON.parse(rawData);
    const uid = await odooAuth();

    const stockData = await fetchAllStock(uid);
    const productIds = [...new Set(stockData.map(q => q.product_id[0]))];
    
    console.log(` 🧬  Cruzando datos para ${productIds.length} productos...`);
    
    const [productsInfo, abcData, velocityMap] = await Promise.all([
        fetchProductDetails(uid, productIds),
        fetchABCData(uid, productIds),
        fetchSalesVelocity(uid, productIds)
    ]);

    const abcMap = {};
    abcData.forEach(row => {
      const pid = row.product_id[0];
      const letter = row.level_id ? row.level_id[1] : "D";
      const current = abcMap[pid] || "D";
      if (letter < current) abcMap[pid] = letter;
      else if (!abcMap[pid]) abcMap[pid] = letter;
    });

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
      
      productMeta[p.id] = {
        abcClass: abcMap[p.id] || "D",
        velocity: velocityMap[p.id] || 0,
        cost: p.standard_price || 0,
        name: p.name || "",
        code: ref,
        season: seasonReal,
        occupancyPerBox: occupancyPerBox
      };
    });

    const contentByID = {};
    stockData.forEach(quant => {
      if (!quant.location_id) return;
      const key = findLocationID(quant.location_id[1]);
      if (!contentByID[key]) contentByID[key] = [];
      const pid = quant.product_id[0];
      const meta = productMeta[pid] || { abcClass: "D", velocity: 0, cost: 0, name: "", code: "", season: "N/A", occupancyPerBox: 10 };

      let surtidoReal = "";
      if (quant.product_set_id) {
        surtidoReal = Array.isArray(quant.product_set_id) ? quant.product_set_id[1] : quant.product_set_id;
      } else {
        surtidoReal = quant.product_id[1] || meta.name || "Sin Surtido";
      }

      contentByID[key].push({
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

    let matches = 0;
    const updatedLocations = locations.map(loc => {
      const myKey = findLocationID(loc.id);
      const realStock = contentByID[myKey];
      let brand = "GENERIC";
      if (loc.id.includes("BD")) brand = "BLACK";
      else if (loc.id.includes("GD")) brand = "GOLD";
      else if (loc.id.includes("WD") || loc.id.includes("WH")) brand = "WHITE";

      if (realStock) {
        matches++;
        const totalStock = realStock.reduce((acc, item) => acc + item.qty, 0);
        const totalReserved = realStock.reduce((acc, item) => acc + item.reservedQty, 0);
        const totalVelocity = realStock.reduce((acc, item) => acc + (item.velocity || 0), 0);

        const uniquePackages = new Set();
        let totalOccupancy = 0;
        realStock.forEach(item => {
          if (!uniquePackages.has(item.packageId)) {
            uniquePackages.add(item.packageId);
            totalOccupancy += item.occupancyVal;
          }
        });

        return {
          ...loc,
          status: totalStock > 0 ? 'OCCUPIED' : 'FREE',
          totalStock: totalStock,
          totalReserved: totalReserved,
          occupancyPercentage: Math.round(totalOccupancy * 100) / 100,
          velocityScore: Math.round(totalVelocity * 100) / 100,
          packages: realStock,
          brand: brand,
          sinDatos: false
        };
      } else {
        return {
          ...loc,
          status: 'FREE',
          totalStock: 0,
          totalReserved: 0,
          occupancyPercentage: 0,
          velocityScore: 0,
          packages: [],
          brand: brand,
          sinDatos: false
        };
      }
    });

    console.log(` ✅  Sync Completo (Ingeniería Full + Temporadas Reales). ${matches} ubicaciones con stock.`);
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