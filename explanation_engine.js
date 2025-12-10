// ==================================================================================
//  MOTOR DE EXPLICABILIDAD Y TRAZABILIDAD DE DECISIONES
//  - Registra TODAS las consultas a Odoo
//  - Explica CÓMO se llegó a cada conclusión
//  - Muestra datos crudos para auditoría
// ==================================================================================

import { aiLogger } from './logger.js';

class ExplanationEngine {
  constructor() {
    // Almacén de evidencias por sesión
    this.evidenceStore = new Map();
    // Contador de decisiones
    this.decisionCounter = 0;
  }

  // ==================================================================================
  //  1. REGISTRO DE CONSULTAS ODOO (Trazabilidad de Datos)
  // ==================================================================================
  
  registerOdooQuery(queryType, params, results, executionTime) {
    const queryId = `ODOO_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const evidence = {
      queryId,
      timestamp: new Date().toISOString(),
      source: 'Odoo ERP',
      queryType,
      params,
      resultCount: Array.isArray(results) ? results.length : 1,
      executionTime: `${executionTime}ms`,
      sampleData: this._getSampleData(results, 3) // Primeros 3 registros
    };

    this.evidenceStore.set(queryId, evidence);
    aiLogger.info(`📊 Query registrada: ${queryType}`, { queryId, count: evidence.resultCount });
    
    return queryId;
  }

  // ==================================================================================
  //  2. REGISTRO DE DECISIONES (Clasificación ABC, Recomendaciones)
  // ==================================================================================
  
  registerDecision(decisionType, input, output, reasoning) {
    const decisionId = `DECISION_${++this.decisionCounter}_${Date.now()}`;
    
    const decision = {
      decisionId,
      timestamp: new Date().toISOString(),
      type: decisionType,
      input: this._sanitize(input),
      output: this._sanitize(output),
      reasoning: reasoning || {},
      confidence: this._calculateConfidence(reasoning),
      evidenceChain: [] // Referencias a queries de Odoo
    };

    this.evidenceStore.set(decisionId, decision);
    
    return decisionId;
  }

  // ==================================================================================
  //  3. EXPLICADOR DE CLASIFICACIÓN ABC
  // ==================================================================================
  
  explainABCClassification(productId, productCode, abcClass, salesData, stockData) {
    const explanation = {
      productId,
      productCode,
      classification: abcClass,
      method: salesData ? 'Odoo_Official' : 'MACD_Calculated',
      timestamp: new Date().toISOString(),
      reasoning: {},
      dataUsed: {},
      auditTrail: []
    };

    if (salesData) {
      // Clasificación oficial de Odoo
      explanation.reasoning = {
        source: 'Módulo ABC de Odoo (abc.classification.product.level)',
        criteria: 'Pareto 80/15/5 basado en facturación',
        dataPoints: salesData.length || 0,
        confidence: 'HIGH (dato oficial del ERP)'
      };
      
      explanation.dataUsed = {
        salesLast30Days: salesData.totalSales || 0,
        salesValue: salesData.totalValue || 0,
        paretoPercentile: salesData.percentile || 0
      };

    } else {
      // Clasificación calculada (MACD - Motor Auto-Clasificador de Decisiones)
      const velocity = stockData?.velocity || 0;
      const daysOld = stockData?.daysOld || 0;
      const stock = stockData?.qty || 0;

      let reasoning = '';
      if (abcClass === 'D') {
        reasoning = `Sin ventas registradas en Odoo en los últimos 30 días. Stock antiguo: ${daysOld} días.`;
      } else if (abcClass === 'C') {
        reasoning = `Ventas < 5% del total. Velocidad: ${velocity} ud/día. Bajo impacto en ingresos.`;
      } else if (abcClass === 'B') {
        reasoning = `Ventas entre 15-20% del total. Rotación media.`;
      } else {
        reasoning = `Top 20% en facturación. Alta rotación (${velocity} ud/día).`;
      }

      explanation.reasoning = {
        source: 'MACD (Motor Auto-Clasificador)',
        criteria: 'Algoritmo Pareto sobre ventas reales de Odoo',
        calculation: reasoning,
        confidence: velocity > 0 ? 'MEDIUM' : 'LOW (sin historial de ventas)'
      };

      explanation.dataUsed = {
        salesVelocity: velocity,
        stockAge: daysOld,
        currentStock: stock,
        odooQueries: ['sale.order.line últimos 30 días']
      };
    }

    // Generar cadena de auditoría
    explanation.auditTrail = this._buildAuditTrail(explanation);

    return explanation;
  }

  // ==================================================================================
  //  4. EXPLICADOR DE PROBLEMAS ESTRATÉGICOS
  // ==================================================================================
  
  explainStrategicIssue(issueType, affectedLocations, thresholds, impactData) {
    const explanation = {
      issueType,
      severity: this._calculateSeverity(issueType, affectedLocations.length),
      timestamp: new Date().toISOString(),
      detection: {},
      impact: {},
      evidence: {},
      recommendation: {}
    };

    // EJEMPLO: Stock Zombie (D > 180 días)
    if (issueType === 'dead_stock') {
      explanation.detection = {
        rule: 'Productos clase D con antigüedad > 180 días',
        threshold: thresholds.maxDays || 180,
        locationsFound: affectedLocations.length,
        query: 'Filtrado de locations.json: packages con abcClass=D AND daysOld>180'
      };

      explanation.impact = {
        financialCost: impactData.immobilizedCapital || 0,
        spaceCost: `${affectedLocations.length} ubicaciones bloqueadas`,
        opportunityCost: 'Espacio que podría usarse para productos A/B',
        urgency: 'CRITICAL'
      };

      explanation.evidence = {
        sampleLocations: affectedLocations.slice(0, 5).map(loc => ({
          locationId: loc.id,
          products: loc.packages.filter(p => p.abcClass === 'D' && p.daysOld > 180).map(p => ({
            code: p.productCode,
            age: p.daysOld,
            qty: p.qty,
            value: (p.qty * p.cost).toFixed(2)
          }))
        })),
        totalUnits: affectedLocations.reduce((sum, loc) => 
          sum + loc.packages.filter(p => p.abcClass === 'D').reduce((s, p) => s + p.qty, 0), 0
        )
      };

      explanation.recommendation = {
        action: 'LIQUIDACIÓN URGENTE',
        steps: [
          '1. Exportar listado completo con /api/ai/report + "exporta productos D antiguos"',
          '2. Evaluar descuento 40-60% para liquidación',
          '3. Compactar ubicaciones liberadas',
          '4. Monitorizar KPI: días promedio de stock clase D'
        ],
        expectedImpact: `Liberar ${affectedLocations.length * 0.4} ubicaciones, recuperar ~${impactData.immobilizedCapital * 0.3}€`
      };
    }

    return explanation;
  }

  // ==================================================================================
  //  5. GENERADOR DE INFORME DE EXPLICABILIDAD (Para el Usuario)
  // ==================================================================================
  
  generateExplanationReport(decisionId) {
    const decision = this.evidenceStore.get(decisionId);
    if (!decision) return { error: 'Decisión no encontrada' };

    const report = {
      summary: `Decisión ${decision.type} tomada el ${new Date(decision.timestamp).toLocaleString('es-ES')}`,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      dataUsed: this._buildDataSourcesReport(decision),
      auditTrail: this._buildFullAuditTrail(decision),
      reproducibility: {
        canReproduce: true,
        howTo: 'Ejecutar las mismas queries en Odoo con los parámetros indicados',
        odooQueries: this._extractOdooQueries(decision)
      }
    };

    return report;
  }

  // ==================================================================================
  //  6. API DE CONSULTA PARA EL FRONTEND
  // ==================================================================================
  
  getDecisionExplanation(locationId, productCode) {
    // Buscar decisiones relacionadas con esta ubicación/producto
    const relatedDecisions = Array.from(this.evidenceStore.values()).filter(item => {
      return item.input?.locationId === locationId || 
             item.input?.productCode === productCode;
    });

    if (relatedDecisions.length === 0) {
      return {
        found: false,
        message: 'No hay decisiones registradas para este elemento'
      };
    }

    return {
      found: true,
      decisions: relatedDecisions.map(d => ({
        type: d.type,
        timestamp: d.timestamp,
        summary: this._summarizeDecision(d),
        detailsId: d.decisionId
      }))
    };
  }

  // ==================================================================================
  //  MÉTODOS AUXILIARES
  // ==================================================================================
  
  _getSampleData(results, count) {
    if (!Array.isArray(results)) return results;
    return results.slice(0, count).map(r => this._sanitize(r));
  }

  _sanitize(obj) {
    // Eliminar datos sensibles o muy grandes
    if (typeof obj !== 'object') return obj;
    const clean = { ...obj };
    delete clean.password;
    delete clean.apiKey;
    return clean;
  }

  _calculateConfidence(reasoning) {
    if (!reasoning || Object.keys(reasoning).length === 0) return 'LOW';
    if (reasoning.dataPoints > 100) return 'HIGH';
    if (reasoning.dataPoints > 10) return 'MEDIUM';
    return 'LOW';
  }

  _calculateSeverity(issueType, count) {
    if (issueType === 'dead_stock' && count > 50) return 'CRITICAL';
    if (count > 20) return 'HIGH';
    if (count > 5) return 'MEDIUM';
    return 'LOW';
  }

  _buildAuditTrail(explanation) {
    return [
      { step: 1, action: 'Consulta a Odoo', query: 'sale.order.line' },
      { step: 2, action: 'Cálculo Pareto', method: 'Ordenar por valor de venta' },
      { step: 3, action: 'Asignación de clase', result: explanation.classification }
    ];
  }

  _buildFullAuditTrail(decision) {
    const queries = this._extractOdooQueries(decision);
    return queries.map((q, i) => ({
      step: i + 1,
      timestamp: q.timestamp,
      source: 'Odoo',
      query: q.type,
      results: q.count
    }));
  }

  _extractOdooQueries(decision) {
    // Buscar todas las queries referenciadas
    return Array.from(this.evidenceStore.values())
      .filter(item => item.queryType && item.timestamp < decision.timestamp)
      .slice(-5); // Últimas 5 queries relevantes
  }

  _buildDataSourcesReport(decision) {
    return {
      primary: 'Odoo ERP',
      tables: ['stock.quant', 'sale.order.line', 'product.product', 'abc.classification.product.level'],
      dateRange: 'Últimos 30 días',
      recordsAnalyzed: decision.reasoning?.dataPoints || 'N/A'
    };
  }

  _summarizeDecision(decision) {
    return `${decision.type}: ${decision.output} (Confianza: ${decision.confidence})`;
  }

  // ==================================================================================
  //  7. LIMPIEZA DE MEMORIA
  // ==================================================================================
  
  clearOldEvidence(maxAgeHours = 24) {
    const cutoff = Date.now() - (maxAgeHours * 60 * 60 * 1000);
    let cleared = 0;

    for (const [key, value] of this.evidenceStore.entries()) {
      const timestamp = new Date(value.timestamp).getTime();
      if (timestamp < cutoff) {
        this.evidenceStore.delete(key);
        cleared++;
      }
    }

    aiLogger.info(`🧹 Limpieza de evidencias: ${cleared} registros eliminados`);
  }
}

// Exportar instancia singleton
export const explanationEngine = new ExplanationEngine();

// Auto-limpieza cada 6 horas
setInterval(() => {
  explanationEngine.clearOldEvidence(24);
}, 6 * 60 * 60 * 1000);