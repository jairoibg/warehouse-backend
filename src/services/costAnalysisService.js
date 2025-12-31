/**
 * Servicio de análisis de costos avanzado
 * Costos de almacenamiento, handling, obsolescencia, etc.
 */

import { getWarehouseContext } from './warehouseService.js';
import { detectDeadStock } from './predictiveService.js';
import { odooExecute, odooAuth } from './odooService.js';
import { logger } from '../middleware/logger.js';

/**
 * Calcula costos totales de almacenamiento
 */
export async function calculateTotalStorageCosts() {
  const { locations, totalValue } = await getWarehouseContext();
  
  // Costos base (configurables)
  const COST_CONFIG = {
    storagePerSquareMeter: 15, // €/m²/mes
    averageLocationSize: 2, // m² por ubicación
    handlingCostPerUnit: 0.50, // €/unidad movida
    obsolescenceRate: 0.06, // 6% anual
    capitalCost: 0.10, // 10% anual
    insuranceRate: 0.01, // 1% anual
  };
  
  const totalLocations = locations.length;
  const occupiedLocations = locations.filter(l => (l.totalStock || 0) > 0).length;
  const totalStock = locations.reduce((sum, l) => sum + (l.totalStock || 0), 0);
  
  // Costos mensuales
  const storageCost = totalLocations * COST_CONFIG.averageLocationSize * COST_CONFIG.storagePerSquareMeter;
  const capitalCost = (totalValue * COST_CONFIG.capitalCost) / 12;
  const obsolescenceCost = (totalValue * COST_CONFIG.obsolescenceRate) / 12;
  const insuranceCost = (totalValue * COST_CONFIG.insuranceRate) / 12;
  
  // Estimación de handling (asumiendo rotación mensual del 20% del stock)
  const estimatedMonthlyMovements = totalStock * 0.20;
  const handlingCost = estimatedMonthlyMovements * COST_CONFIG.handlingCostPerUnit;
  
  const totalMonthlyCost = storageCost + capitalCost + obsolescenceCost + insuranceCost + handlingCost;
  const totalAnnualCost = totalMonthlyCost * 12;
  
  return {
    monthly: {
      storage: storageCost,
      capital: capitalCost,
      obsolescence: obsolescenceCost,
      insurance: insuranceCost,
      handling: handlingCost,
      total: totalMonthlyCost
    },
    annual: {
      total: totalAnnualCost,
      asPercentageOfInventory: (totalAnnualCost / totalValue) * 100
    },
    metrics: {
      totalLocations,
      occupiedLocations,
      totalStock,
      inventoryValue: totalValue,
      costPerUnit: totalMonthlyCost / totalStock,
      costPerLocation: totalMonthlyCost / totalLocations
    }
  };
}

/**
 * Análisis de rentabilidad por producto
 */
export async function analyzeProductProfitability() {
  try {
    const uid = await odooAuth();
    
    // Obtener productos con ventas y costes
    const sales = await odooExecute(
      'sale.order.line',
      'search_read',
      [[
        ['order_id.date_order', '>=', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]],
        ['state', 'in', ['sale', 'done']]
      ]],
      { 
        fields: ['product_id', 'product_uom_qty', 'price_unit', 'price_total', 'purchase_price'],
        limit: 10000
      }
    );
    
    const productMap = {};
    
    sales.forEach(line => {
      const productId = line.product_id[0];
      const productName = line.product_id[1];
      const qty = line.product_uom_qty || 0;
      const revenue = line.price_total || 0;
      const cost = (line.purchase_price || 0) * qty;
      const margin = revenue - cost;
      
      if (!productMap[productId]) {
        productMap[productId] = {
          productId,
          productName,
          totalQty: 0,
          totalRevenue: 0,
          totalCost: 0,
          totalMargin: 0,
          salesCount: 0
        };
      }
      
      productMap[productId].totalQty += qty;
      productMap[productId].totalRevenue += revenue;
      productMap[productId].totalCost += cost;
      productMap[productId].totalMargin += margin;
      productMap[productId].salesCount += 1;
    });
    
    // Calcular métricas
    const profitability = Object.values(productMap).map(p => ({
      ...p,
      marginPercentage: p.totalRevenue > 0 ? (p.totalMargin / p.totalRevenue) * 100 : 0,
      avgMarginPerUnit: p.totalQty > 0 ? p.totalMargin / p.totalQty : 0,
      avgRevenuePerUnit: p.totalQty > 0 ? p.totalRevenue / p.totalQty : 0
    })).sort((a, b) => b.totalMargin - a.totalMargin);
    
    return {
      period: 'Últimos 90 días',
      totalProducts: profitability.length,
      topProfitable: profitability.slice(0, 20),
      topUnprofitable: profitability.slice(-10).reverse(),
      summary: {
        totalRevenue: profitability.reduce((sum, p) => sum + p.totalRevenue, 0),
        totalCost: profitability.reduce((sum, p) => sum + p.totalCost, 0),
        totalMargin: profitability.reduce((sum, p) => sum + p.totalMargin, 0),
        avgMarginPercentage: profitability.length > 0 
          ? profitability.reduce((sum, p) => sum + p.marginPercentage, 0) / profitability.length 
          : 0
      }
    };
  } catch (error) {
    logger.error('Error analizando rentabilidad', { error: error.message });
    return null;
  }
}

/**
 * Análisis de costos por marca
 */
export async function analyzeCostsByBrand() {
  const { locations } = await getWarehouseContext();
  const deadStock = await detectDeadStock(180);
  
  const brandAnalysis = {
    BLACK: { locations: 0, stock: 0, value: 0, deadStockValue: 0, occupancy: 0 },
    GOLD: { locations: 0, stock: 0, value: 0, deadStockValue: 0, occupancy: 0 },
    WHITE: { locations: 0, stock: 0, value: 0, deadStockValue: 0, occupancy: 0 },
    GENERIC: { locations: 0, stock: 0, value: 0, deadStockValue: 0, occupancy: 0 }
  };
  
  locations.forEach(loc => {
    const brand = loc.brand || 'GENERIC';
    const brandKey = brand.includes('BLACK') ? 'BLACK' :
                     brand.includes('GOLD') ? 'GOLD' :
                     brand.includes('WHITE') ? 'WHITE' : 'GENERIC';
    
    brandAnalysis[brandKey].locations += 1;
    brandAnalysis[brandKey].stock += loc.totalStock || 0;
    brandAnalysis[brandKey].value += loc.packages?.reduce((sum, p) => sum + ((p.qty || 0) * (p.cost || 0)), 0) || 0;
    brandAnalysis[brandKey].occupancy += loc.occupancyPercentage || 0;
  });
  
  // Agrupar stock muerto por marca
  deadStock.forEach(item => {
    const code = item.productCode || '';
    let brand = 'GENERIC';
    if (code.includes('DF') || code.includes('BLACK')) brand = 'BLACK';
    else if (code.includes('CO') || code.includes('GOLD') || code.includes('BW')) brand = 'GOLD';
    else if (code.includes('KA') || code.includes('WHITE')) brand = 'WHITE';
    
    brandAnalysis[brand].deadStockValue += item.totalValue;
  });
  
  // Calcular promedios
  Object.keys(brandAnalysis).forEach(brand => {
    const data = brandAnalysis[brand];
    data.avgOccupancy = data.locations > 0 ? data.occupancy / data.locations : 0;
    data.deadStockPercentage = data.value > 0 ? (data.deadStockValue / data.value) * 100 : 0;
  });
  
  return brandAnalysis;
}

/**
 * Análisis de eficiencia de espacio
 */
export async function analyzeSpaceEfficiency() {
  const { locations } = await getWarehouseContext();
  
  const efficiency = {
    totalLocations: locations.length,
    occupiedLocations: locations.filter(l => (l.totalStock || 0) > 0).length,
    emptyLocations: locations.filter(l => (l.totalStock || 0) === 0).length,
    lowOccupancy: locations.filter(l => (l.occupancyPercentage || 0) > 0 && (l.occupancyPercentage || 0) < 30).length,
    highOccupancy: locations.filter(l => (l.occupancyPercentage || 0) > 95).length,
    consolidationOpportunities: []
  };
  
  efficiency.occupancyRate = (efficiency.occupiedLocations / efficiency.totalLocations) * 100;
  efficiency.wasteRate = (efficiency.emptyLocations / efficiency.totalLocations) * 100;
  
  // Identificar oportunidades de consolidación
  const lowOccupancyLocs = locations.filter(l => 
    (l.occupancyPercentage || 0) > 0 && 
    (l.occupancyPercentage || 0) < 30 &&
    (l.totalStock || 0) > 0
  );
  
  efficiency.consolidationOpportunities = lowOccupancyLocs.slice(0, 20).map(loc => ({
    locationId: loc.id,
    occupancy: loc.occupancyPercentage,
    stock: loc.totalStock,
    estimatedSavings: (30 - (loc.occupancyPercentage || 0)) * 2 * 15 // m² ahorrados * coste mensual
  }));
  
  return efficiency;
}



