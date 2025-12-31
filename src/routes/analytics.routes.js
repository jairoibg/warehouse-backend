/**
 * Rutas para analytics y análisis avanzado
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { odooExecute, odooAuth, fetchAllRecords } from '../services/odooService.js';
import { predictStockOut, analyzeStockRisk, forecastDemand, detectDeadStock } from '../services/predictiveService.js';
import { getWarehouseContext } from '../services/warehouseService.js';
import { strategicAnalyzer } from '../../strategic_analyzer.js';

const router = express.Router();

/**
 * GET /api/analytics/icc
 * Análisis de Inventory Carrying Cost
 */
router.get('/icc', asyncHandler(async (req, res) => {
  console.log('💰 [ICC] Calculando coste de almacenamiento...');
  
  const ICC_CONFIG = {
    BASE_ANNUAL_RATE: {
      capitalCost: 0.10,
      obsolescenceBase: 0.06,
      riskService: 0.02,
    },
    SEASON_DEPRECIATION_ANNUAL: {
      current: 0.00,
      previous_1: 0.06,
      previous_2: 0.12,
      previous_3: 0.18,
      previous_4_plus: 0.24,
    },
  };

  function parseSeason(seasonStr) {
    if (!seasonStr || typeof seasonStr !== 'string') return null;
    const match = seasonStr.match(/^([IV])(\d{2})$/i);
    if (!match) return null;
    const type = match[1].toUpperCase();
    const year = parseInt(match[2], 10);
    const baseYear = 17;
    const ordinal = ((year - baseYear) * 2) + (type === 'V' ? 1 : 0);
    return { type, year, ordinal, original: seasonStr };
  }

  function getSeasonDistance(productSeason, currentSeason) {
    const prod = parseSeason(productSeason);
    const curr = parseSeason(currentSeason);
    if (!prod || !curr) return 999;
    return curr.ordinal - prod.ordinal;
  }

  function getCurrentSeason() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear() % 100;
    if (month >= 2 && month <= 7) return `V${year}`;
    else if (month >= 8) return `I${year + 1}`;
    else return `I${year}`;
  }

  function calculateMonthlyICCRate(productSeason, currentSeason) {
    const distance = getSeasonDistance(productSeason, currentSeason);
    const baseAnnual = ICC_CONFIG.BASE_ANNUAL_RATE.capitalCost + 
                       ICC_CONFIG.BASE_ANNUAL_RATE.obsolescenceBase + 
                       ICC_CONFIG.BASE_ANNUAL_RATE.riskService;
    
    let seasonDepreciation = 0;
    if (distance <= 0) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.current;
    else if (distance === 1) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_1;
    else if (distance === 2) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_2;
    else if (distance === 3) seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_3;
    else seasonDepreciation = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_4_plus;
    
    return {
      monthlyRate: (baseAnnual + seasonDepreciation) / 12,
      annualRate: baseAnnual + seasonDepreciation,
      seasonDistance: distance,
    };
  }

  const currentSeason = getCurrentSeason();
  const uid = await odooAuth();

  const stockQuants = await odooExecute(
    'stock.quant',
    'search_read',
    [[['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]],
    { fields: ['product_id', 'quantity', 'value', 'location_id'], limit: 50000 }
  );

  const productIds = [...new Set(stockQuants.map(q => q.product_id[0]))];
  
  const products = await odooExecute(
    'product.product',
    'search_read',
    [[['id', 'in', productIds]]],
    { fields: ['id', 'sale_season_id', 'standard_price', 'list_price'] }
  );

  const productMap = {};
  products.forEach(p => {
    productMap[p.id] = {
      season: p.sale_season_id ? p.sale_season_id[1] : null,
      cost: p.standard_price > 0 ? p.standard_price : (p.list_price * 0.4),
    };
  });

  const results = {
    currentSeason,
    totalStockValue: 0,
    totalMonthlyCost: 0,
    totalAnnualCost: 0,
    effectiveRate: 0,
    bySeason: {},
    bySeasonDistance: {
      current: { label: 'Temporada actual', value: 0, cost: 0, rate: 18 },
      previous_1: { label: '1 temp. atrás', value: 0, cost: 0, rate: 24 },
      previous_2: { label: '2 temp. atrás', value: 0, cost: 0, rate: 30 },
      previous_3: { label: '3 temp. atrás', value: 0, cost: 0, rate: 36 },
      previous_4_plus: { label: '4+ temp. atrás', value: 0, cost: 0, rate: 42 },
      unknown: { label: 'Sin temporada', value: 0, cost: 0, rate: 18 },
    },
    breakdown: {
      capitalCost: { label: 'Coste de capital', value: 0, rate: 10 },
      obsolescenceBase: { label: 'Obsolescencia base', value: 0, rate: 6 },
      riskService: { label: 'Riesgo/Servicio', value: 0, rate: 2 },
      seasonDepreciation: { label: 'Deprec. temporal', value: 0, rate: 'variable' },
    },
    metrics: {
      costPerUnit: 0,
      costPerLocation: 0,
      dailyDepreciation: 0,
      sixMonthProjection: 0,
    },
    topSeasons: [],
  };

  let totalUnits = 0;
  const locationIds = new Set();

  stockQuants.forEach(quant => {
    const product = productMap[quant.product_id[0]];
    if (!product) return;

    const qty = quant.quantity;
    const unitCost = product.cost;
    const stockValue = qty * unitCost;
    const finalValue = quant.value > 0 ? quant.value : stockValue;

    const season = product.season;
    const iccData = calculateMonthlyICCRate(season, currentSeason);
    const monthlyCost = finalValue * iccData.monthlyRate;

    results.totalStockValue += finalValue;
    results.totalMonthlyCost += monthlyCost;
    results.totalAnnualCost += finalValue * iccData.annualRate;

    results.breakdown.capitalCost.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.capitalCost / 12);
    results.breakdown.obsolescenceBase.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.obsolescenceBase / 12);
    results.breakdown.riskService.value += finalValue * (ICC_CONFIG.BASE_ANNUAL_RATE.riskService / 12);
    
    const seasonDepRate = iccData.annualRate - 0.18;
    results.breakdown.seasonDepreciation.value += finalValue * (seasonDepRate / 12);

    const seasonKey = season || 'SIN_TEMPORADA';
    if (!results.bySeason[seasonKey]) {
      results.bySeason[seasonKey] = { value: 0, monthlyCost: 0, rate: iccData.annualRate };
    }
    results.bySeason[seasonKey].value += finalValue;
    results.bySeason[seasonKey].monthlyCost += monthlyCost;

    const distance = iccData.seasonDistance;
    let distanceKey;
    if (!season) distanceKey = 'unknown';
    else if (distance <= 0) distanceKey = 'current';
    else if (distance === 1) distanceKey = 'previous_1';
    else if (distance === 2) distanceKey = 'previous_2';
    else if (distance === 3) distanceKey = 'previous_3';
    else distanceKey = 'previous_4_plus';

    results.bySeasonDistance[distanceKey].value += finalValue;
    results.bySeasonDistance[distanceKey].cost += monthlyCost;

    totalUnits += qty;
    locationIds.add(quant.location_id[0]);
  });

  results.effectiveRate = (results.totalAnnualCost / results.totalStockValue) * 100;
  results.metrics.costPerUnit = results.totalMonthlyCost / totalUnits;
  results.metrics.costPerLocation = results.totalMonthlyCost / locationIds.size;
  results.metrics.dailyDepreciation = results.totalMonthlyCost / 30;
  results.metrics.sixMonthProjection = results.totalMonthlyCost * 6;

  results.topSeasons = Object.entries(results.bySeason)
    .map(([season, data]) => ({
      season,
      value: data.value,
      monthlyCost: data.monthlyCost,
      rate: data.rate,
    }))
    .sort((a, b) => b.monthlyCost - a.monthlyCost)
    .slice(0, 10);

  console.log(`✅ [ICC] Calculado: €${results.totalMonthlyCost.toFixed(2)}/mes`);
  
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    data: results,
  });
}));

/**
 * GET /api/analytics/weights-2025
 * Distribución de pesos 2025
 */
router.get('/weights-2025', asyncHandler(async (req, res) => {
  console.log(" ⚖️  [ANALYTICS] Iniciando cálculo de distribución de pesos 2025...");

  const uid = await odooAuth();

  const domain = [
    ['date', '>=', '2025-01-01 00:00:00'],
    ['date', '<=', '2025-12-31 23:59:59'],
    ['picking_type_id.code', '=', 'outgoing'],
    ['state', '=', 'done']
  ];

  const moves = await fetchAllRecords('stock.move', domain, ['product_id', 'product_uom_qty']);
  console.log(` 📦  Movimientos encontrados: ${moves.length}`);

  const productIds = [...new Set(moves.map(m => m.product_id[0]))];
  
  let productsInfo = [];
  for (let i = 0; i < productIds.length; i += 2000) {
    const slice = productIds.slice(i, i + 2000);
    const batch = await odooExecute('product.product', 'read', [slice], { fields: ['default_code', 'weight'] });
    productsInfo = productsInfo.concat(batch);
  }

  const productMap = {};
  productsInfo.forEach(p => {
    const code = (p.default_code || "").toUpperCase();
    let brand = "GENERIC";
    if (code.includes("DF") || code.includes("BLACK")) brand = "BLACK";
    else if (code.includes("KA") || code.includes("WHITE")) brand = "WHITE";
    else if (code.includes("CO") || code.includes("GOLD") || code.includes("BW")) brand = "GOLD";
    
    productMap[p.id] = {
      weight: p.weight || 0,
      brand: brand,
      code: code
    };
  });

  const distribution = { BLACK: {}, GOLD: {}, WHITE: {}, TOTAL: {} };

  moves.forEach(m => {
    const pid = m.product_id[0];
    const info = productMap[pid];
    if (!info) return;

    const weightGrams = Math.round(info.weight * 1000);
    const bucket = weightGrams >= 1000 ? `${(weightGrams/1000).toFixed(1)}kg` : `${weightGrams}g`;
    const qty = m.product_uom_qty;

    if (distribution[info.brand]) {
      distribution[info.brand][bucket] = (distribution[info.brand][bucket] || 0) + qty;
    }
    distribution.TOTAL[bucket] = (distribution.TOTAL[bucket] || 0) + qty;
  });

  if (req.query.export === 'true') {
    const fs = await import('fs/promises');
    const pathModule = await import('path');
    const { fileURLToPath } = await import('url');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = pathModule.dirname(__filename);
    const EXPORT_DIR = pathModule.join(__dirname, '../../exports');
    const config = getConfig();
    
    console.log(" 📂 [ANALYTICS] Generando archivo CSV de pesos...");
    let csvContent = "MARCA;RANGO_PESO;CANTIDAD_UNIDADES\n";

    ['BLACK', 'GOLD', 'WHITE', 'GENERIC'].forEach(brand => {
      if (distribution[brand]) {
        Object.entries(distribution[brand]).forEach(([bucket, qty]) => {
          csvContent += `${brand};${bucket};${qty}\n`;
        });
      }
    });
    
    if (distribution.TOTAL) {
      Object.entries(distribution.TOTAL).forEach(([bucket, qty]) => {
        csvContent += `TOTAL_GLOBAL;${bucket};${qty}\n`;
      });
    }

    const filename = `distribucion_pesos_2025_${Date.now()}.csv`;
    const filePath = pathModule.join(EXPORT_DIR, filename);
    
    await fs.mkdir(EXPORT_DIR, { recursive: true });
    await fs.writeFile(filePath, csvContent, 'utf8');

    const SERVER_HOST = config.server.host;
    const PORT = config.server.port;

    return res.json({
      success: true,
      period: "2025",
      total_moves: moves.length,
      distribution: distribution,
      download_link: `http://${SERVER_HOST}:${PORT}/downloads/${filename}`,
      message: "Archivo generado correctamente."
    });
  }

  res.json({
    success: true,
    period: "2025",
    total_moves: moves.length,
    distribution: distribution
  });
}));

/**
 * GET /api/analytics/stock-risk
 * Análisis de riesgo de stock bajo
 */
router.get('/stock-risk', asyncHandler(async (req, res) => {
  const { daysAhead = 30 } = req.query;
  const risks = await analyzeStockRisk(parseInt(daysAhead));
  res.json({
    success: true,
    daysAhead: parseInt(daysAhead),
    risks,
    summary: {
      critical: risks.filter(r => r.risk === 'CRITICAL').length,
      high: risks.filter(r => r.risk === 'HIGH').length,
      medium: risks.filter(r => r.risk === 'MEDIUM').length,
      total: risks.length
    }
  });
}));

/**
 * GET /api/analytics/dead-stock
 * Detección de stock muerto
 */
router.get('/dead-stock', asyncHandler(async (req, res) => {
  const { daysThreshold = 180 } = req.query;
  const deadStock = await detectDeadStock(parseInt(daysThreshold));
  
  const totalValue = deadStock.reduce((sum, item) => sum + item.totalValue, 0);
  
  res.json({
    success: true,
    daysThreshold: parseInt(daysThreshold),
    count: deadStock.length,
    totalValue,
    products: deadStock
  });
}));

/**
 * GET /api/analytics/forecast/:productCode
 * Forecasting de demanda para un producto
 */
router.get('/forecast/:productCode', asyncHandler(async (req, res) => {
  const { productCode } = req.params;
  const { periods = 30 } = req.query;
  
  const forecast = await forecastDemand(productCode, parseInt(periods));
  res.json({
    success: true,
    ...forecast
  });
}));

export default router;

