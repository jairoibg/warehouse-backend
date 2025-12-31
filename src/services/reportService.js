/**
 * Servicio de generación de reportes automáticos
 * PDF, Excel, CSV
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getWarehouseContext } from './warehouseService.js';
import { analyzeStockRisk, detectDeadStock } from './predictiveService.js';
import { generateAllAlerts } from './alertService.js';
import { logger } from '../middleware/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORTS_DIR = path.join(__dirname, '../../reports');

// Asegurar que existe el directorio
import fsSync from 'fs';
if (!fsSync.existsSync(REPORTS_DIR)) {
  fsSync.mkdirSync(REPORTS_DIR, { recursive: true });
}

/**
 * Genera reporte CSV de inventario
 */
export async function generateInventoryCSV(filters = {}) {
  const { locations } = await getWarehouseContext();
  
  let filtered = locations;
  
  if (filters.brand && filters.brand !== 'ALL') {
    filtered = filtered.filter(loc => loc.id.includes(filters.brand));
  }
  
  if (filters.abc_class) {
    filtered = filtered.filter(loc => 
      loc.packages?.some(p => p.abcClass === filters.abc_class)
    );
  }
  
  const header = 'ID_UBICACION;MARCA;STOCK_TOTAL;OCUPACION_%;CLASE_ABC;DIAS_MAX;VALOR_€\n';
  
  const rows = filtered.map(loc => {
    const classes = [...new Set(loc.packages?.map(p => p.abcClass) || [])].join('+');
    const maxDays = Math.max(...(loc.packages?.map(p => p.daysOld || 0) || [0]), 0);
    const value = loc.packages?.reduce((sum, p) => sum + ((p.qty || 0) * (p.cost || 0)), 0) || 0;
    
    return `${loc.id};${loc.brand || 'N/A'};${loc.totalStock || 0};${Math.round(loc.occupancyPercentage || 0)};${classes};${maxDays};${value.toFixed(2)}`;
  }).join('\n');
  
  const filename = `inventory_report_${Date.now()}.csv`;
  const filepath = path.join(REPORTS_DIR, filename);
  
  await fs.writeFile(filepath, header + rows, 'utf8');
  
  return { filename, filepath, count: filtered.length };
}

/**
 * Genera reporte de alertas en formato texto
 */
export async function generateAlertsReport() {
  const alerts = await generateAllAlerts();
  
  const lines = [
    'REPORTE DE ALERTAS',
    `Fecha: ${new Date().toLocaleString('es-ES')}`,
    `Total de alertas: ${alerts.length}`,
    '',
    ...alerts.map(alert => {
      return [
        `[${alert.severity}] ${alert.title}`,
        `  ${alert.message}`,
        `  Tipo: ${alert.type}`,
        `  Timestamp: ${alert.timestamp}`,
        ''
      ].join('\n');
    })
  ];
  
  const filename = `alerts_report_${Date.now()}.txt`;
  const filepath = path.join(REPORTS_DIR, filename);
  
  await fs.writeFile(filepath, lines.join('\n'), 'utf8');
  
  return { filename, filepath, count: alerts.length };
}

/**
 * Genera reporte de stock en riesgo
 */
export async function generateStockRiskReport(daysAhead = 30) {
  const risks = await analyzeStockRisk(daysAhead);
  
  const header = 'PRODUCTO;STOCK_ACTUAL;VELOCIDAD;DIAS_HASTA_AGOTARSE;RIESGO;RECOMENDACION;UBICACIONES\n';
  
  const rows = risks.map(risk => {
    const locations = risk.locations?.join(', ') || 'N/A';
    return `${risk.productCode};${risk.currentStock};${risk.velocity.toFixed(2)};${risk.daysUntilOut === Infinity ? '∞' : risk.daysUntilOut};${risk.risk};${risk.recommendation};${locations}`;
  }).join('\n');
  
  const filename = `stock_risk_report_${Date.now()}.csv`;
  const filepath = path.join(REPORTS_DIR, filename);
  
  await fs.writeFile(filepath, header + rows, 'utf8');
  
  return { filename, filepath, count: risks.length };
}

/**
 * Genera reporte de stock muerto
 */
export async function generateDeadStockReport(daysThreshold = 180) {
  const deadStock = await detectDeadStock(daysThreshold);
  
  const header = 'PRODUCTO;CANTIDAD;VALOR_€;ANTIGUEDAD_DIAS;CLASE_ABC;TEMPORADA;UBICACIONES\n';
  
  const rows = deadStock.map(item => {
    const locations = item.locations?.join(', ') || 'N/A';
    return `${item.productCode};${item.totalQuantity};${item.totalValue.toFixed(2)};${item.maxDaysOld};${item.abcClass};${item.season || 'N/A'};${locations}`;
  }).join('\n');
  
  const filename = `dead_stock_report_${Date.now()}.csv`;
  const filepath = path.join(REPORTS_DIR, filename);
  
  await fs.writeFile(filepath, header + rows, 'utf8');
  
  return { filename, filepath, count: deadStock.length };
}

/**
 * Genera reporte ejecutivo completo (markdown)
 */
export async function generateExecutiveReport() {
  const { locations, totalValue } = await getWarehouseContext();
  const alerts = await generateAllAlerts();
  const risks = await analyzeStockRisk(30);
  const deadStock = await detectDeadStock(180);
  
  const totalLocations = locations.length;
  const occupiedLocations = locations.filter(l => (l.totalStock || 0) > 0).length;
  const avgOccupancy = locations.reduce((sum, l) => sum + (l.occupancyPercentage || 0), 0) / totalLocations;
  
  const criticalAlerts = alerts.filter(a => a.severity === 'CRITICAL').length;
  const criticalRisks = risks.filter(r => r.risk === 'CRITICAL').length;
  const deadStockValue = deadStock.reduce((sum, item) => sum + item.totalValue, 0);
  
  const report = [
    '# REPORTE EJECUTIVO DE ALMACÉN',
    `**Fecha:** ${new Date().toLocaleString('es-ES')}`,
    '',
    '## RESUMEN EJECUTIVO',
    '',
    `- **Valor Total de Inventario:** €${totalValue.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`,
    `- **Total de Ubicaciones:** ${totalLocations}`,
    `- **Ubicaciones Ocupadas:** ${occupiedLocations} (${((occupiedLocations/totalLocations)*100).toFixed(1)}%)`,
    `- **Ocupación Promedio:** ${avgOccupancy.toFixed(1)}%`,
    '',
    '## ALERTAS Y RIESGOS',
    '',
    `- **Alertas Críticas:** ${criticalAlerts}`,
    `- **Productos con Stock Bajo Crítico:** ${criticalRisks}`,
    `- **Stock Muerto:** ${deadStock.length} productos (€${deadStockValue.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})})`,
    '',
    '## RECOMENDACIONES',
    '',
    ...(criticalAlerts > 0 ? [`- ⚠️ **URGENTE:** ${criticalAlerts} alertas críticas requieren atención inmediata`] : []),
    ...(criticalRisks > 0 ? [`- 📦 **STOCK:** ${criticalRisks} productos necesitan reposición urgente`] : []),
    ...(deadStock.length > 10 ? [`- 💀 **STOCK MUERTO:** Considerar liquidación de ${deadStock.length} productos sin rotación`] : []),
    ...(avgOccupancy < 30 ? [`- 📊 **OCUPACIÓN:** Oportunidad de consolidación de espacio (ocupación promedio: ${avgOccupancy.toFixed(1)}%)`] : []),
    '',
    '---',
    `*Generado automáticamente el ${new Date().toLocaleString('es-ES')}*`
  ].join('\n');
  
  const filename = `executive_report_${Date.now()}.md`;
  const filepath = path.join(REPORTS_DIR, filename);
  
  await fs.writeFile(filepath, report, 'utf8');
  
  return { filename, filepath };
}

/**
 * Programa reportes automáticos
 */
export async function scheduleAutomaticReports() {
  const schedule = {
    daily: async () => {
      logger.info('Generando reporte diario automático');
      const report = await generateExecutiveReport();
      logger.info(`Reporte diario generado: ${report.filename}`);
    },
    weekly: async () => {
      logger.info('Generando reporte semanal automático');
      const [executive, risks, deadStock] = await Promise.all([
        generateExecutiveReport(),
        generateStockRiskReport(30),
        generateDeadStockReport(180)
      ]);
      logger.info(`Reportes semanales generados: ${executive.filename}, ${risks.filename}, ${deadStock.filename}`);
    }
  };
  
  return schedule;
}



