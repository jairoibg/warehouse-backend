/**
 * Servicio de exportación avanzada (PDF, Excel con gráficos)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { getWarehouseContext } from './warehouseService.js';
import { generateAllAlerts } from './alertService.js';
import { calculateTotalStorageCosts, analyzeProductProfitability } from './costAnalysisService.js';
import { analyzeStockRisk, detectDeadStock } from './predictiveService.js';
import { generateIntelligentRecommendations } from './recommendationService.js';
import { logger } from '../middleware/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXPORTS_DIR = path.join(__dirname, '../../exports');

// Asegurar directorio
import fsSync from 'fs';
if (!fsSync.existsSync(EXPORTS_DIR)) {
  fsSync.mkdirSync(EXPORTS_DIR, { recursive: true });
}

/**
 * Genera reporte Excel avanzado con formato y gráficos
 */
export async function generateExcelReport(type = 'inventory') {
  const workbook = new ExcelJS.Workbook();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${type}_report_${timestamp}.xlsx`;
  const filepath = path.join(EXPORTS_DIR, filename);
  
  if (type === 'inventory') {
    const { locations } = await getWarehouseContext();
    const worksheet = workbook.addWorksheet('Inventario');
    
    // Encabezados con formato
    worksheet.columns = [
      { header: 'ID Ubicación', key: 'id', width: 20 },
      { header: 'Marca', key: 'brand', width: 15 },
      { header: 'Stock Total', key: 'stock', width: 12 },
      { header: 'Ocupación %', key: 'occupancy', width: 12 },
      { header: 'Clase ABC', key: 'abc', width: 12 },
      { header: 'Días Máx', key: 'days', width: 12 },
      { header: 'Valor €', key: 'value', width: 15 }
    ];
    
    // Estilo de encabezado
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    
    // Datos
    locations.forEach(loc => {
      const classes = [...new Set(loc.packages?.map(p => p.abcClass) || [])].join('+');
      const maxDays = Math.max(...(loc.packages?.map(p => p.daysOld || 0) || [0]), 0);
      const value = loc.packages?.reduce((sum, p) => sum + ((p.qty || 0) * (p.cost || 0)), 0) || 0;
      
      worksheet.addRow({
        id: loc.id,
        brand: loc.brand || 'N/A',
        stock: loc.totalStock || 0,
        occupancy: Math.round(loc.occupancyPercentage || 0),
        abc: classes,
        days: maxDays,
        value: parseFloat(value.toFixed(2))
      });
    });
    
    // Nota: Para agregar gráficos reales, usar exceljs charts
    // worksheet.addChart({ ... });
    
  } else if (type === 'executive') {
    const { locations, totalValue } = await getWarehouseContext();
    const alerts = await generateAllAlerts();
    const costs = await calculateTotalStorageCosts();
    const risks = await analyzeStockRisk(30);
    const deadStock = await detectDeadStock(180);
    
    // Hoja 1: Resumen Ejecutivo
    const summarySheet = workbook.addWorksheet('Resumen Ejecutivo');
    summarySheet.columns = [
      { header: 'Métrica', key: 'metric', width: 30 },
      { header: 'Valor', key: 'value', width: 20 }
    ];
    
    summarySheet.getRow(1).font = { bold: true };
    summarySheet.addRow({ metric: 'Valor Total Inventario', value: `€${totalValue.toLocaleString('es-ES')}` });
    summarySheet.addRow({ metric: 'Total Ubicaciones', value: locations.length });
    summarySheet.addRow({ metric: 'Ubicaciones Ocupadas', value: locations.filter(l => (l.totalStock || 0) > 0).length });
    summarySheet.addRow({ metric: 'Alertas Críticas', value: alerts.filter(a => a.severity === 'CRITICAL').length });
    summarySheet.addRow({ metric: 'Productos en Riesgo', value: risks.filter(r => r.risk === 'CRITICAL').length });
    summarySheet.addRow({ metric: 'Stock Muerto', value: `${deadStock.length} productos` });
    summarySheet.addRow({ metric: 'Costos Mensuales', value: `€${costs.monthly.total.toLocaleString('es-ES')}` });
    summarySheet.addRow({ metric: 'Costos Anuales', value: `€${costs.annual.total.toLocaleString('es-ES')}` });
    
    // Hoja 2: Alertas
    const alertsSheet = workbook.addWorksheet('Alertas');
    alertsSheet.columns = [
      { header: 'Severidad', key: 'severity', width: 12 },
      { header: 'Título', key: 'title', width: 40 },
      { header: 'Mensaje', key: 'message', width: 50 },
      { header: 'Tipo', key: 'type', width: 20 }
    ];
    
    alertsSheet.getRow(1).font = { bold: true };
    alerts.forEach(alert => {
      alertsSheet.addRow({
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        type: alert.type
      });
    });
    
    // Hoja 3: Riesgos de Stock
    const risksSheet = workbook.addWorksheet('Riesgos de Stock');
    risksSheet.columns = [
      { header: 'Producto', key: 'product', width: 20 },
      { header: 'Stock Actual', key: 'stock', width: 12 },
      { header: 'Días Restantes', key: 'days', width: 15 },
      { header: 'Riesgo', key: 'risk', width: 12 },
      { header: 'Recomendación', key: 'recommendation', width: 40 }
    ];
    
    risksSheet.getRow(1).font = { bold: true };
    risks.slice(0, 50).forEach(risk => {
      risksSheet.addRow({
        product: risk.productCode,
        stock: risk.currentStock,
        days: risk.daysUntilOut === Infinity ? '∞' : risk.daysUntilOut,
        risk: risk.risk,
        recommendation: risk.recommendation
      });
    });
  }
  
  await workbook.xlsx.writeFile(filepath);
  
  return { filename, filepath, format: 'xlsx' };
}

/**
 * Genera reporte PDF básico (Markdown formateado)
 * Nota: Para PDF real, usar librerías como pdfkit o puppeteer
 */
export async function generatePDFReport() {
  const { locations, totalValue } = await getWarehouseContext();
  const alerts = await generateAllAlerts();
  const costs = await calculateTotalStorageCosts();
  
  const markdown = `# REPORTE EJECUTIVO DE ALMACÉN

**Fecha:** ${new Date().toLocaleString('es-ES')}

## RESUMEN EJECUTIVO

- **Valor Total de Inventario:** €${totalValue.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
- **Total de Ubicaciones:** ${locations.length}
- **Ubicaciones Ocupadas:** ${locations.filter(l => (l.totalStock || 0) > 0).length}
- **Costos Mensuales:** €${costs.monthly.total.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
- **Costos Anuales:** €${costs.annual.total.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}

## ALERTAS

Total de alertas: ${alerts.length}
- Críticas: ${alerts.filter(a => a.severity === 'CRITICAL').length}
- Altas: ${alerts.filter(a => a.severity === 'HIGH').length}

${alerts.slice(0, 10).map(a => `### ${a.title}\n${a.message}\n`).join('\n')}

---

*Generado automáticamente el ${new Date().toLocaleString('es-ES')}*
`;
  
  const filename = `executive_report_${Date.now()}.md`;
  const filepath = path.join(EXPORTS_DIR, filename);
  
  await fs.writeFile(filepath, markdown, 'utf8');
  
  // Nota: Para convertir a PDF real, usar:
  // - pdfkit: Generar PDF desde Node.js
  // - puppeteer: Renderizar HTML/Markdown a PDF
  // - markdown-pdf: Convertir Markdown directamente
  
  return { filename, filepath, format: 'markdown', note: 'Para PDF real, instalar librería de conversión' };
}

