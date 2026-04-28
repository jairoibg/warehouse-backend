/**
 * Script de prueba para generar reporte de variantes y costes
 */

import { generateVariantCostReport } from './src/services/variantCostReportService.js';

async function testReport() {
  try {
    console.log('📊 Generando reporte de variantes y costes...\n');
    
    const report = await generateVariantCostReport();
    
    console.log('✅ Reporte generado exitosamente!');
    console.log('\n📋 Detalles:');
    console.log(`   - Archivo: ${report.filename}`);
    console.log(`   - Ruta: ${report.filepath}`);
    console.log(`   - Registros: ${report.recordCount.toLocaleString()}`);
    console.log(`   - Variantes únicas: ${report.variantCount.toLocaleString()}`);
    console.log(`   - Coste total: €${report.totalCost.toLocaleString('es-ES', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    console.log(`\n📥 Para descargar: http://localhost:4000/api/reports/download/${report.filename}`);
    
  } catch (error) {
    console.error('❌ Error generando reporte:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

testReport();

