/**
 * Simulador de escenarios (What-if analysis)
 */

import { getWarehouseContext } from './warehouseService.js';
import { calculateSalesVelocity } from './predictiveService.js';
import { calculateTotalStorageCosts } from './costAnalysisService.js';
import { logger } from '../middleware/logger.js';

/**
 * Simula escenario de aumento de ventas
 */
export async function simulateSalesIncrease(percentage, days = 30) {
  const { locations } = await getWarehouseContext();
  
  // Agrupar stock por producto
  const productStock = {};
  locations.forEach(loc => {
    loc.packages?.forEach(pkg => {
      const code = pkg.productCode || pkg.surtido || 'UNKNOWN';
      if (!productStock[code]) {
        productStock[code] = {
          productCode: code,
          currentStock: 0
        };
      }
      productStock[code].currentStock += pkg.qty || 0;
    });
  });
  
  const scenarios = [];
  
  // Calcular velocidad de ventas para cada producto
  for (const [code, data] of Object.entries(productStock)) {
    if (data.currentStock === 0) continue;
    
    try {
      // Calcular velocidad de ventas actual
      const currentVelocity = await calculateSalesVelocity(code, 90);
      
      if (currentVelocity === 0) {
        // Producto sin rotación, saltar
        continue;
      }
      
      // Calcular nueva velocidad con el aumento
      const newVelocity = currentVelocity * (1 + percentage / 100);
      const daysUntilOut = Math.floor(data.currentStock / newVelocity);
      const currentDaysUntilOut = Math.floor(data.currentStock / currentVelocity);
      
      scenarios.push({
        productCode: code,
        currentVelocity: parseFloat(currentVelocity.toFixed(2)),
        newVelocity: parseFloat(newVelocity.toFixed(2)),
        currentDaysUntilOut: currentDaysUntilOut === Infinity ? 999 : currentDaysUntilOut,
        newDaysUntilOut: daysUntilOut === Infinity ? 999 : daysUntilOut,
        riskIncrease: daysUntilOut < 14 ? 'HIGH' : daysUntilOut < 30 ? 'MEDIUM' : 'LOW',
        recommendation: daysUntilOut < 14 
          ? 'Aumentar stock antes del cambio'
          : daysUntilOut < 30
          ? 'Monitorear de cerca'
          : 'Stock suficiente'
      });
    } catch (error) {
      logger.warn(`Error calculando velocidad para ${code}:`, error.message);
      // Continuar con el siguiente producto
      continue;
    }
  }
  
  return {
    scenario: `Aumento de ventas del ${percentage}%`,
    period: `${days} días`,
    totalProducts: scenarios.length,
    atRisk: scenarios.filter(s => s.riskIncrease === 'HIGH').length,
    scenarios: scenarios.filter(s => s.riskIncrease === 'HIGH' || s.riskIncrease === 'MEDIUM').slice(0, 50)
  };
}

/**
 * Simula escenario de reducción de inventario
 */
export async function simulateInventoryReduction(percentage) {
  const { locations, totalValue } = await getWarehouseContext();
  const currentCosts = await calculateTotalStorageCosts();
  
  const reduction = totalValue * (percentage / 100);
  const newValue = totalValue - reduction;
  
  // Estimar nuevos costos (proporcional)
  const newMonthlyCost = currentCosts.monthly.total * (newValue / totalValue);
  const savings = currentCosts.monthly.total - newMonthlyCost;
  
  // Identificar productos candidatos para reducción
  const candidates = [];
  locations.forEach(loc => {
    loc.packages?.forEach(pkg => {
      if ((pkg.daysOld || 0) > 180 || (pkg.abcClass || 'D') === 'D') {
        const value = (pkg.qty || 0) * (pkg.cost || 0);
        candidates.push({
          locationId: loc.id,
          productCode: pkg.productCode || pkg.surtido,
          quantity: pkg.qty,
          value: value,
          daysOld: pkg.daysOld,
          abcClass: pkg.abcClass
        });
      }
    });
  });
  
  // Ordenar por valor y seleccionar hasta alcanzar el porcentaje
  candidates.sort((a, b) => b.value - a.value);
  
  let accumulatedValue = 0;
  const selected = [];
  
  for (const candidate of candidates) {
    if (accumulatedValue >= reduction) break;
    selected.push(candidate);
    accumulatedValue += candidate.value;
  }
  
  return {
    scenario: `Reducción de inventario del ${percentage}%`,
    currentValue: totalValue,
    targetValue: newValue,
    reduction: reduction,
    selectedProducts: selected.length,
    monthlySavings: savings,
    annualSavings: savings * 12,
    products: selected.slice(0, 50)
  };
}

/**
 * Simula escenario de optimización de espacio
 */
export async function simulateSpaceOptimization() {
  const { locations } = await getWarehouseContext();
  
  const emptyLocs = locations.filter(l => (l.totalStock || 0) === 0);
  const lowOccupancyLocs = locations.filter(l => 
    (l.occupancyPercentage || 0) > 0 && 
    (l.occupancyPercentage || 0) < 30
  );
  
  // Simular consolidación
  const consolidationPlan = [];
  const processed = new Set();
  
  lowOccupancyLocs.forEach(loc => {
    if (processed.has(loc.id)) return;
    
    // Extraer pasillo de la ubicación (formato: P01-01-01 -> pasillo 01)
    const locAisle = loc.id?.match(/P(\d+)/)?.[1] || '0';
    
    const similarLocs = lowOccupancyLocs.filter(l => {
      if (l.id === loc.id || processed.has(l.id)) return false;
      
      // Comparar por marca si existe
      if (loc.brand && l.brand && loc.brand !== l.brand) return false;
      
      // Comparar por pasillo cercano
      const lAisle = l.id?.match(/P(\d+)/)?.[1] || '0';
      const aisleDiff = Math.abs(parseInt(locAisle) - parseInt(lAisle));
      
      return aisleDiff <= 2;
    });
    
    if (similarLocs.length > 0) {
      const totalStock = (loc.totalStock || 0) + similarLocs.reduce((sum, l) => sum + (l.totalStock || 0), 0);
      const canConsolidate = totalStock <= 100; // Asumiendo capacidad de 100 unidades
      
      if (canConsolidate) {
        consolidationPlan.push({
          targetLocation: loc.id,
          sourceLocations: similarLocs.map(l => l.id),
          totalStock: totalStock,
          freedLocations: similarLocs.length,
          estimatedSavings: similarLocs.length * 2 * 15 // m² * coste mensual
        });
        
        processed.add(loc.id);
        similarLocs.forEach(l => processed.add(l.id));
      }
    }
  });
  
  const totalFreed = consolidationPlan.reduce((sum, p) => sum + p.freedLocations, 0);
  const totalSavings = consolidationPlan.reduce((sum, p) => sum + p.estimatedSavings, 0);
  
  return {
    scenario: 'Optimización de espacio',
    emptyLocations: emptyLocs.length,
    lowOccupancyLocations: lowOccupancyLocs.length,
    consolidationPlans: consolidationPlan.length,
    totalLocationsFreed: totalFreed,
    estimatedMonthlySavings: totalSavings,
    estimatedAnnualSavings: totalSavings * 12,
    plans: consolidationPlan.slice(0, 20)
  };
}

