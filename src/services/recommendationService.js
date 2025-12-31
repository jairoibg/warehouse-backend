/**
 * Sistema de recomendaciones inteligentes basado en IA
 */

import { getWarehouseContext } from './warehouseService.js';
import { analyzeStockRisk, detectDeadStock } from './predictiveService.js';
import { generateAllAlerts } from './alertService.js';
import { calculateTotalStorageCosts, analyzeSpaceEfficiency } from './costAnalysisService.js';
import { getOpenAIClient } from './aiService.js';
import { logger } from '../middleware/logger.js';

/**
 * Genera recomendaciones inteligentes usando IA
 */
export async function generateIntelligentRecommendations() {
  try {
    const [locations, risks, deadStock, alerts, costs, efficiency] = await Promise.all([
      getWarehouseContext().then(ctx => ctx.locations),
      analyzeStockRisk(30),
      detectDeadStock(180),
      generateAllAlerts(),
      calculateTotalStorageCosts(),
      analyzeSpaceEfficiency()
    ]);
    
    const criticalRisks = risks.filter(r => r.risk === 'CRITICAL' || r.risk === 'HIGH');
    const criticalAlerts = alerts.filter(a => a.severity === 'CRITICAL' || a.severity === 'HIGH');
    
    // Preparar contexto para IA
    const context = {
      inventory: {
        totalValue: costs.metrics.inventoryValue,
        totalLocations: costs.metrics.totalLocations,
        occupiedLocations: costs.metrics.occupiedLocations,
        occupancyRate: efficiency.occupancyRate
      },
      risks: {
        stockLow: criticalRisks.length,
        deadStock: deadStock.length,
        deadStockValue: deadStock.reduce((sum, item) => sum + item.totalValue, 0)
      },
      alerts: {
        critical: criticalAlerts.length,
        total: alerts.length
      },
      costs: {
        monthly: costs.monthly.total,
        annual: costs.annual.total,
        asPercentage: costs.annual.asPercentageOfInventory
      },
      efficiency: {
        emptyLocations: efficiency.emptyLocations,
        lowOccupancy: efficiency.lowOccupancy,
        consolidationOpportunities: efficiency.consolidationOpportunities.length
      }
    };
    
    // Generar recomendaciones con ChatGPT
    const openai = getOpenAIClient();
    const prompt = `Eres un consultor experto en optimización de almacenes. Analiza estos datos y genera recomendaciones prioritarias y accionables.

CONTEXTO:
- Valor de inventario: €${context.inventory.totalValue.toLocaleString('es-ES')}
- Ubicaciones: ${context.inventory.occupiedLocations}/${context.inventory.totalLocations} ocupadas (${context.inventory.occupancyRate.toFixed(1)}%)
- Costos mensuales: €${context.costs.monthly.toLocaleString('es-ES')}
- Alertas críticas: ${context.alerts.critical}
- Productos con stock bajo: ${context.risks.stockLow}
- Stock muerto: ${context.risks.deadStock} productos (€${context.risks.deadStockValue.toLocaleString('es-ES')})
- Ubicaciones vacías: ${context.efficiency.emptyLocations}
- Oportunidades de consolidación: ${context.efficiency.consolidationOpportunities}

Genera 5-10 recomendaciones PRIORITARIAS, CONCRETAS y ACCIONABLES. Para cada una, indica:
1. Prioridad (ALTA/MEDIA/BAJA)
2. Impacto estimado (€ ahorrados/ganados o % mejora)
3. Esfuerzo requerido (BAJO/MEDIO/ALTO)
4. Acciones específicas

Formato JSON:
{
  "recommendations": [
    {
      "priority": "ALTA",
      "category": "Stock/Inventario",
      "title": "Título corto",
      "description": "Descripción detallada",
      "impact": "€X ahorrados o Y% mejora",
      "effort": "BAJO",
      "actions": ["Acción 1", "Acción 2"],
      "estimatedSavings": 0
    }
  ]
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }]
    });
    
    const text = response.choices[0].message.content;
    
    // Extraer JSON de la respuesta
    let recommendations;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        recommendations = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No se encontró JSON en la respuesta');
      }
    } catch (e) {
      logger.warn('Error parseando recomendaciones de IA, usando fallback', { error: e.message });
      recommendations = generateFallbackRecommendations(context);
    }
    
    // Agregar recomendaciones automáticas basadas en reglas
    const ruleBased = generateRuleBasedRecommendations(context, risks, deadStock, efficiency);
    
    return {
      aiRecommendations: recommendations.recommendations || [],
      ruleBasedRecommendations: ruleBased,
      context,
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Error generando recomendaciones', { error: error.message });
    return {
      aiRecommendations: [],
      ruleBasedRecommendations: generateFallbackRecommendations({}),
      error: error.message
    };
  }
}

/**
 * Recomendaciones basadas en reglas (fallback)
 */
function generateRuleBasedRecommendations(context, risks, deadStock, efficiency) {
  const recommendations = [];
  
  if (context.risks.stockLow > 10) {
    recommendations.push({
      priority: 'ALTA',
      category: 'Stock',
      title: 'Reposición urgente de stock bajo',
      description: `${context.risks.stockLow} productos necesitan reposición inmediata`,
      impact: `Evitar rotura de stock`,
      effort: 'MEDIO',
      actions: ['Revisar productos críticos', 'Contactar proveedores', 'Acelerar pedidos pendientes']
    });
  }
  
  if (context.risks.deadStockValue > 10000) {
    recommendations.push({
      priority: 'ALTA',
      category: 'Optimización',
      title: 'Liquidación de stock muerto',
      description: `€${context.risks.deadStockValue.toLocaleString('es-ES')} en stock sin rotación`,
      impact: `Liberar capital y espacio`,
      effort: 'ALTO',
      actions: ['Identificar productos para liquidación', 'Crear promociones', 'Donar o destruir si no es viable']
    });
  }
  
  if (context.efficiency.emptyLocations > 100) {
    recommendations.push({
      priority: 'MEDIA',
      category: 'Espacio',
      title: 'Consolidación de ubicaciones vacías',
      description: `${context.efficiency.emptyLocations} ubicaciones vacías`,
      impact: `Ahorro estimado: €${(context.efficiency.emptyLocations * 2 * 15).toLocaleString('es-ES')}/mes`,
      effort: 'MEDIO',
      actions: ['Reorganizar layout', 'Compactar ubicaciones ocupadas', 'Liberar espacio no utilizado']
    });
  }
  
  if (context.costs.annual.asPercentage > 25) {
    recommendations.push({
      priority: 'MEDIA',
      category: 'Costos',
      title: 'Optimización de costos de almacenamiento',
      description: `Costos representan ${context.costs.annual.asPercentage.toFixed(1)}% del inventario`,
      impact: `Reducir costos operativos`,
      effort: 'ALTO',
      actions: ['Revisar contratos de almacenamiento', 'Optimizar layout', 'Mejorar rotación']
    });
  }
  
  return recommendations;
}

function generateFallbackRecommendations(context) {
  return {
    recommendations: generateRuleBasedRecommendations(context, [], [], {})
  };
}

/**
 * Recomendaciones de slotting (optimización de ubicaciones)
 */
export async function generateSlottingRecommendations() {
  const { locations } = await getWarehouseContext();
  
  // Analizar velocidad vs ubicación
  const slottingIssues = [];
  
  locations.forEach(loc => {
    if (!loc.packages || loc.packages.length === 0) return;
    
    const packages = loc.packages;
    const avgVelocity = packages.reduce((sum, p) => sum + (p.velocity || 0), 0) / packages.length;
    const hasHighVelocity = packages.some(p => (p.velocity || 0) > 1.0);
    const hasLowVelocity = packages.some(p => (p.velocity || 0) < 0.1);
    
    // Productos de alta velocidad en ubicaciones lejanas (pasillo > 10)
    if (hasHighVelocity && parseInt(loc.aisle) > 10) {
      slottingIssues.push({
        locationId: loc.id,
        issue: 'HIGH_VELOCITY_FAR',
        currentAisle: loc.aisle,
        recommendation: 'Mover a pasillo más cercano (1-5)',
        priority: 'MEDIA',
        products: packages.filter(p => (p.velocity || 0) > 1.0).map(p => p.productCode)
      });
    }
    
    // Productos de baja velocidad en ubicaciones cercanas
    if (hasLowVelocity && parseInt(loc.aisle) <= 5) {
      slottingIssues.push({
        locationId: loc.id,
        issue: 'LOW_VELOCITY_NEAR',
        currentAisle: loc.aisle,
        recommendation: 'Mover a pasillo más lejano (10+)',
        priority: 'BAJA',
        products: packages.filter(p => (p.velocity || 0) < 0.1).map(p => p.productCode)
      });
    }
  });
  
  return {
    totalIssues: slottingIssues.length,
    highPriority: slottingIssues.filter(s => s.priority === 'ALTA' || s.priority === 'MEDIA').length,
    recommendations: slottingIssues.slice(0, 20)
  };
}



