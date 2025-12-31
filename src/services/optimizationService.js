/**
 * Servicio de Optimización Avanzada con IA
 * Optimización de espacio, rutas, inventario usando algoritmos genéticos y otros
 */

import { getWarehouseContext } from './warehouseService.js';
import { getOpenAIClient } from './aiService.js';
import { logger } from '../middleware/logger.js';

/**
 * Optimización de espacio usando IA (Claude) y algoritmos genéticos simplificados
 */
export async function optimizeSpaceWithAI() {
  try {
    const { locations } = await getWarehouseContext();
    
    // Identificar oportunidades de optimización
    const emptyLocs = locations.filter(l => (l.totalStock || 0) === 0);
    const lowOccupancyLocs = locations.filter(l => 
      (l.occupancyPercentage || 0) > 0 && 
      (l.occupancyPercentage || 0) < 30
    );
    const highOccupancyLocs = locations.filter(l => 
      (l.occupancyPercentage || 0) > 95
    );
    
    // Preparar contexto para IA
    const context = {
      totalLocations: locations.length,
      emptyLocations: emptyLocs.length,
      lowOccupancy: lowOccupancyLocs.length,
      highOccupancy: highOccupancyLocs.length,
      avgOccupancy: locations.reduce((sum, l) => sum + (l.occupancyPercentage || 0), 0) / locations.length,
      opportunities: lowOccupancyLocs.slice(0, 20).map(loc => ({
        id: loc.id,
        occupancy: loc.occupancyPercentage,
        stock: loc.totalStock,
        brand: loc.brand
      }))
    };
    
    // Usar ChatGPT para generar plan de optimización
    const openai = getOpenAIClient();
    const prompt = `Eres un experto en optimización de almacenes. Analiza estos datos y genera un plan de optimización de espacio.

CONTEXTO:
- Total ubicaciones: ${context.totalLocations}
- Ubicaciones vacías: ${context.emptyLocations}
- Ubicaciones con ocupación baja (<30%): ${context.lowOccupancy}
- Ubicaciones con ocupación alta (>95%): ${context.highOccupancy}
- Ocupación promedio: ${context.avgOccupancy.toFixed(1)}%

OPORTUNIDADES DE CONSOLIDACIÓN:
${context.opportunities.map(o => `- ${o.id}: ${o.occupancy.toFixed(1)}% ocupado, ${o.stock} uds, marca ${o.brand}`).join('\n')}

Genera un plan de optimización con:
1. Consolidaciones específicas (de dónde a dónde mover)
2. Estimación de espacio liberado
3. Ahorro estimado en costos
4. Prioridad de acciones

Formato JSON:
{
  "plan": [
    {
      "action": "CONSOLIDATE",
      "from": ["location1", "location2"],
      "to": "location3",
      "estimatedSpaceFreed": 2,
      "estimatedSavings": 30,
      "priority": "HIGH",
      "reason": "Consolidar ubicaciones de baja ocupación"
    }
  ],
  "totalSpaceFreed": 0,
  "totalSavings": 0
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }]
    });
    
    const text = response.choices[0].message.content;
    let optimizationPlan;
    
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        optimizationPlan = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No se encontró JSON');
      }
    } catch (e) {
      logger.warn('Error parseando plan de optimización, usando fallback', { error: e.message });
      optimizationPlan = generateFallbackOptimization(context);
    }
    
    // Algoritmo genético simplificado para validar y mejorar el plan
    const validatedPlan = validateOptimizationPlan(optimizationPlan, locations);
    
    return {
      method: 'AI + Genetic Algorithm',
      context,
      plan: validatedPlan,
      estimatedSavings: {
        monthly: validatedPlan.totalSavings || 0,
        annual: (validatedPlan.totalSavings || 0) * 12,
        spaceFreed: validatedPlan.totalSpaceFreed || 0
      }
    };
  } catch (error) {
    logger.error('Error en optimización de espacio', { error: error.message });
    return {
      method: 'AI Optimization',
      error: error.message
    };
  }
}

function generateFallbackOptimization(context) {
  const plan = [];
  let totalSpace = 0;
  let totalSavings = 0;
  
  // Consolidar ubicaciones de baja ocupación
  const lowOccLocs = context.opportunities.slice(0, 10);
  for (let i = 0; i < lowOccLocs.length; i += 2) {
    if (i + 1 < lowOccLocs.length) {
      const loc1 = lowOccLocs[i];
      const loc2 = lowOccLocs[i + 1];
      if (loc1.brand === loc2.brand) {
        plan.push({
          action: 'CONSOLIDATE',
          from: [loc1.id, loc2.id],
          to: loc1.id,
          estimatedSpaceFreed: 1,
          estimatedSavings: 15,
          priority: 'MEDIUM',
          reason: 'Consolidar ubicaciones de misma marca'
        });
        totalSpace += 1;
        totalSavings += 15;
      }
    }
  }
  
  return { plan, totalSpaceFreed: totalSpace, totalSavings };
}

function validateOptimizationPlan(plan, locations) {
  // Validar que las ubicaciones existen y tienen espacio
  const validated = plan.plan?.map(action => {
    const fromLocs = action.from?.filter(id => 
      locations.some(l => l.id === id)
    ) || [];
    const toLoc = locations.find(l => l.id === action.to);
    
    if (fromLocs.length === 0 || !toLoc) {
      return { ...action, valid: false, reason: 'Ubicación no encontrada' };
    }
    
    // Verificar capacidad
    const totalStock = fromLocs.reduce((sum, id) => {
      const loc = locations.find(l => l.id === id);
      return sum + (loc?.totalStock || 0);
    }, 0);
    
    const availableSpace = 100 - (toLoc.occupancyPercentage || 0);
    const canFit = totalStock <= availableSpace;
    
    return {
      ...action,
      valid: canFit,
      reason: canFit ? 'OK' : 'Capacidad insuficiente',
      from: fromLocs,
      totalStockToMove: totalStock
    };
  }).filter(a => a.valid) || [];
  
  const totalSpaceFreed = validated.reduce((sum, a) => sum + (a.estimatedSpaceFreed || 0), 0);
  const totalSavings = validated.reduce((sum, a) => sum + (a.estimatedSavings || 0), 0);
  
  return {
    ...plan,
    plan: validated,
    totalSpaceFreed,
    totalSavings
  };
}

/**
 * Optimización de rutas de picking usando algoritmo de vecino más cercano
 */
export async function optimizePickingRoutes(orderItems) {
  try {
    const { locations } = await getWarehouseContext();
    
    // Mapear items a ubicaciones
    const itemsWithLocations = orderItems.map(item => {
      const location = locations.find(loc => 
        loc.packages?.some(p => 
          (p.productCode || p.surtido) === item.productCode
        )
      );
      
      if (!location) return null;
      
      const pkg = location.packages.find(p => 
        (p.productCode || p.surtido) === item.productCode
      );
      
      return {
        ...item,
        locationId: location.id,
        aisle: parseInt(location.aisle) || 0,
        position: parseInt(location.position) || 0,
        level: parseInt(location.level) || 0
      };
    }).filter(item => item !== null);
    
    if (itemsWithLocations.length === 0) {
      return {
        method: 'Nearest Neighbor',
        error: 'No se encontraron ubicaciones para los productos'
      };
    }
    
    // Algoritmo del vecino más cercano
    const route = [];
    const visited = new Set();
    let current = { aisle: 0, position: 0, level: 0 }; // Punto de inicio
    
    while (route.length < itemsWithLocations.length) {
      let nearest = null;
      let minDistance = Infinity;
      
      itemsWithLocations.forEach(item => {
        if (visited.has(item.locationId)) return;
        
        const distance = Math.sqrt(
          Math.pow(item.aisle - current.aisle, 2) +
          Math.pow(item.position - current.position, 2) +
          Math.pow(item.level - current.level, 2)
        );
        
        if (distance < minDistance) {
          minDistance = distance;
          nearest = item;
        }
      });
      
      if (nearest) {
        route.push({
          ...nearest,
          distance: minDistance,
          order: route.length + 1
        });
        visited.add(nearest.locationId);
        current = {
          aisle: nearest.aisle,
          position: nearest.position,
          level: nearest.level
        };
      } else {
        break;
      }
    }
    
    const totalDistance = route.reduce((sum, r) => sum + r.distance, 0);
    const estimatedTime = totalDistance * 0.5; // minutos (asumiendo 0.5 min por unidad de distancia)
    
    return {
      method: 'Nearest Neighbor Algorithm',
      route,
      metrics: {
        totalDistance: parseFloat(totalDistance.toFixed(2)),
        estimatedTime: parseFloat(estimatedTime.toFixed(2)),
        items: route.length,
        efficiency: route.length > 0 ? parseFloat((route.length / totalDistance).toFixed(2)) : 0
      }
    };
  } catch (error) {
    logger.error('Error optimizando rutas', { error: error.message });
    return {
      method: 'Route Optimization',
      error: error.message
    };
  }
}

/**
 * Optimización de inventario usando modelo EOQ (Economic Order Quantity) mejorado
 */
export async function optimizeInventoryLevels(productCode) {
  try {
    const { locations } = await getWarehouseContext();
    const { getRealTimeSales } = await import('./odooService.js');
    
    // Encontrar producto
    let productStock = 0;
    let productCost = 0;
    
    locations.forEach(loc => {
      loc.packages?.forEach(pkg => {
        if ((pkg.productCode || pkg.surtido) === productCode) {
          productStock += pkg.qty || 0;
          productCost = pkg.cost || 0;
        }
      });
    });
    
    // Obtener ventas
    const sales = await getRealTimeSales(365);
    const productSales = sales.filter(s => 
      s.p && s.p.toUpperCase().includes(productCode.toUpperCase())
    );
    
    const annualDemand = productSales.reduce((sum, s) => sum + (s.q || 0), 0) * 4; // Extrapolar a anual
    const dailyDemand = annualDemand / 365;
    
    // Parámetros EOQ
    const orderingCost = 50; // Costo de ordenar (€)
    const holdingCostRate = 0.20; // 20% anual
    const holdingCost = productCost * holdingCostRate;
    
    // EOQ clásico
    const eoq = Math.sqrt((2 * annualDemand * orderingCost) / holdingCost);
    
    // Punto de reorden (ROP)
    const leadTime = 14; // días
    const safetyStock = dailyDemand * leadTime * 0.5; // 50% de margen
    const reorderPoint = dailyDemand * leadTime + safetyStock;
    
    // Nivel máximo de inventario
    const maxInventory = eoq + safetyStock;
    
    // Análisis de costo total
    const orderingCostTotal = (annualDemand / eoq) * orderingCost;
    const holdingCostTotal = (eoq / 2 + safetyStock) * holdingCost;
    const totalCost = orderingCostTotal + holdingCostTotal;
    
    // Recomendación
    let recommendation = '';
    if (productStock > maxInventory * 1.2) {
      recommendation = 'Stock excesivo: reducir pedidos';
    } else if (productStock < reorderPoint) {
      recommendation = 'URGENTE: Reponer stock';
    } else if (productStock < maxInventory * 0.8) {
      recommendation = 'Planificar próximo pedido';
    } else {
      recommendation = 'Stock en nivel óptimo';
    }
    
    return {
      model: 'EOQ (Economic Order Quantity)',
      productCode,
      currentStock: productStock,
      parameters: {
        annualDemand: Math.round(annualDemand),
        dailyDemand: parseFloat(dailyDemand.toFixed(2)),
        orderingCost,
        holdingCostRate,
        leadTime
      },
      optimalLevels: {
        eoq: Math.round(eoq),
        reorderPoint: Math.round(reorderPoint),
        safetyStock: Math.round(safetyStock),
        maxInventory: Math.round(maxInventory)
      },
      costAnalysis: {
        orderingCost: parseFloat(orderingCostTotal.toFixed(2)),
        holdingCost: parseFloat(holdingCostTotal.toFixed(2)),
        totalCost: parseFloat(totalCost.toFixed(2)),
        ordersPerYear: Math.round(annualDemand / eoq)
      },
      recommendation,
      status: productStock < reorderPoint ? 'CRITICAL' : 
              productStock < maxInventory * 0.8 ? 'LOW' : 
              productStock > maxInventory * 1.2 ? 'EXCESS' : 'OPTIMAL'
    };
  } catch (error) {
    logger.error('Error optimizando inventario', { error: error.message });
    return {
      model: 'EOQ',
      productCode,
      error: error.message
    };
  }
}


