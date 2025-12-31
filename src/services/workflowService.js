/**
 * Sistema de workflows y automatizaciones avanzadas
 */

import { generateAllAlerts } from './alertService.js';
import { analyzeStockRisk, detectDeadStock } from './predictiveService.js';
import { generateIntelligentRecommendations } from './recommendationService.js';
import { calculateTotalStorageCosts } from './costAnalysisService.js';
import { sendCriticalAlertsNotification, sendStockRiskNotification } from './notificationService.js';
import { generateExecutiveReport, scheduleAutomaticReports } from './reportService.js';
import { logger } from '../middleware/logger.js';

// Definición de workflows
const WORKFLOWS = {
  dailyHealthCheck: {
    name: 'Verificación Diaria de Salud',
    schedule: '0 9 * * *', // 9 AM diario
    enabled: true,
    steps: [
      {
        name: 'Generar Alertas',
        action: async () => await generateAllAlerts(),
        onFailure: 'log'
      },
      {
        name: 'Analizar Riesgos de Stock',
        action: async () => await analyzeStockRisk(14),
        onFailure: 'log'
      },
      {
        name: 'Generar Recomendaciones',
        action: async () => await generateIntelligentRecommendations(),
        onFailure: 'skip'
      },
      {
        name: 'Enviar Notificaciones si hay Alertas Críticas',
        action: async () => {
          const alerts = await generateAllAlerts();
          if (alerts.filter(a => a.severity === 'CRITICAL').length > 0) {
            return await sendCriticalAlertsNotification();
          }
          return { skipped: true, reason: 'No hay alertas críticas' };
        },
        onFailure: 'log'
      }
    ]
  },
  
  weeklyExecutiveReport: {
    name: 'Reporte Ejecutivo Semanal',
    schedule: '0 8 * * 1', // Lunes 8 AM
    enabled: true,
    steps: [
      {
        name: 'Generar Reporte Ejecutivo',
        action: async () => await generateExecutiveReport(),
        onFailure: 'retry'
      },
      {
        name: 'Calcular Costos',
        action: async () => await calculateTotalStorageCosts(),
        onFailure: 'log'
      },
      {
        name: 'Analizar Rentabilidad',
        action: async () => await generateIntelligentRecommendations(),
        onFailure: 'skip'
      }
    ]
  },
  
  stockLowAlert: {
    name: 'Alerta de Stock Bajo',
    schedule: '0 */6 * * *', // Cada 6 horas
    enabled: true,
    steps: [
      {
        name: 'Analizar Riesgos de Stock',
        action: async () => await analyzeStockRisk(7), // Próximos 7 días
        onFailure: 'log'
      },
      {
        name: 'Enviar Notificación si hay Riesgos Críticos',
        action: async () => {
          const risks = await analyzeStockRisk(7);
          const critical = risks.filter(r => r.risk === 'CRITICAL');
          if (critical.length > 5) {
            return await sendStockRiskNotification();
          }
          return { skipped: true, reason: 'Riesgos por debajo del umbral' };
        },
        onFailure: 'log'
      }
    ]
  },
  
  deadStockReview: {
    name: 'Revisión de Stock Muerto',
    schedule: '0 10 * * 0', // Domingo 10 AM
    enabled: true,
    steps: [
      {
        name: 'Detectar Stock Muerto',
        action: async () => await detectDeadStock(180),
        onFailure: 'log'
      },
      {
        name: 'Generar Recomendaciones de Liquidación',
        action: async () => {
          const deadStock = await detectDeadStock(180);
          if (deadStock.length > 10) {
            const recommendations = await generateIntelligentRecommendations();
            return {
              deadStockCount: deadStock.length,
              totalValue: deadStock.reduce((sum, item) => sum + item.totalValue, 0),
              recommendations: recommendations.ruleBasedRecommendations.filter(r => 
                r.category === 'Optimización' && r.title.includes('Liquidación')
              )
            };
          }
          return { skipped: true, reason: 'Stock muerto por debajo del umbral' };
        },
        onFailure: 'skip'
      }
    ]
  },
  
  costOptimization: {
    name: 'Optimización de Costos',
    schedule: '0 9 * * 5', // Viernes 9 AM
    enabled: true,
    steps: [
      {
        name: 'Calcular Costos Totales',
        action: async () => await calculateTotalStorageCosts(),
        onFailure: 'log'
      },
      {
        name: 'Generar Recomendaciones de Optimización',
        action: async () => await generateIntelligentRecommendations(),
        onFailure: 'skip'
      },
      {
        name: 'Analizar Eficiencia de Espacio',
        action: async () => {
          const { analyzeSpaceEfficiency } = await import('./costAnalysisService.js');
          return await analyzeSpaceEfficiency();
        },
        onFailure: 'skip'
      }
    ]
  }
};

/**
 * Ejecuta un workflow
 */
export async function executeWorkflow(workflowName) {
  const workflow = WORKFLOWS[workflowName];
  
  if (!workflow) {
    throw new Error(`Workflow ${workflowName} no encontrado`);
  }
  
  if (!workflow.enabled) {
    logger.info(`Workflow ${workflowName} está deshabilitado`);
    return { executed: false, reason: 'Workflow deshabilitado' };
  }
  
  logger.info(`Ejecutando workflow: ${workflow.name}`);
  const results = [];
  const errors = [];
  
  for (const step of workflow.steps) {
    try {
      logger.debug(`Ejecutando paso: ${step.name}`);
      const result = await step.action();
      results.push({
        step: step.name,
        success: true,
        result: result
      });
    } catch (error) {
      logger.error(`Error en paso ${step.name}`, { error: error.message });
      errors.push({
        step: step.name,
        error: error.message
      });
      
      if (step.onFailure === 'stop') {
        break;
      } else if (step.onFailure === 'retry') {
        // Intentar una vez más
        try {
          const result = await step.action();
          results.push({
            step: step.name,
            success: true,
            result: result,
            retried: true
          });
        } catch (retryError) {
          errors.push({
            step: step.name,
            error: retryError.message,
            retried: true
          });
        }
      }
      // Si onFailure es 'skip' o 'log', continuar
    }
  }
  
  return {
    workflow: workflowName,
    executed: true,
    timestamp: new Date().toISOString(),
    results,
    errors,
    success: errors.length === 0
  };
}

/**
 * Obtiene todos los workflows disponibles
 */
export function getAvailableWorkflows() {
  return Object.entries(WORKFLOWS).map(([key, workflow]) => ({
    id: key,
    name: workflow.name,
    schedule: workflow.schedule,
    enabled: workflow.enabled,
    stepsCount: workflow.steps.length
  }));
}

/**
 * Habilita/deshabilita un workflow
 */
export function toggleWorkflow(workflowName, enabled) {
  if (!WORKFLOWS[workflowName]) {
    throw new Error(`Workflow ${workflowName} no encontrado`);
  }
  
  WORKFLOWS[workflowName].enabled = enabled;
  logger.info(`Workflow ${workflowName} ${enabled ? 'habilitado' : 'deshabilitado'}`);
  
  return { workflow: workflowName, enabled };
}

/**
 * Programa workflows automáticos (simplificado - en producción usar cron)
 */
export function startWorkflowScheduler() {
  logger.info('Programador de workflows iniciado');
  
  // En producción, usaría node-cron o similar
  // Por ahora, solo registramos que está activo
  return {
    status: 'active',
    workflows: Object.keys(WORKFLOWS).filter(key => WORKFLOWS[key].enabled)
  };
}



