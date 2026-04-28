import fs from 'fs/promises';

async function fusionar() {
  console.log('📂 Cargando archivos...');
  
  const original = JSON.parse(await fs.readFile('data/locations.json', 'utf-8'));
  const nuevas = JSON.parse(await fs.readFile('data/locations_test.json', 'utf-8'));
  
  console.log(`Original: ${original.length} ubicaciones`);
  console.log(`Test (Odoo): ${nuevas.length} ubicaciones`);
  
  // Encontrar ubicaciones que están en nuevas pero no en original
  const originalIds = new Set(original.map(l => l.id));
  const nuevasUnicas = nuevas.filter(l => !originalIds.has(l.id));
  
  console.log(`Nuevas únicas a añadir: ${nuevasUnicas.length}`);
  
  // Añadir campos faltantes a las nuevas
  nuevasUnicas.forEach(loc => {
    loc.sinDatos = false;
    loc.type = loc.id.includes('EXTB2B') ? 'B2B' : 'B2C';
    loc.x = 0;
    loc.y = 0;
  });
  
  const fusionado = [...original, ...nuevasUnicas];
  
  // Backup del original
  await fs.copyFile('data/locations.json', 'data/locations_backup_antes_fusion.json');
  console.log('✅ Backup creado: locations_backup_antes_fusion.json');
  
  // Guardar fusionado (sin BOM)
  await fs.writeFile('data/locations_fusionado.json', JSON.stringify(fusionado, null, 2));
  
  console.log('\n=== RESULTADO ===');
  console.log(`Original: ${original.length}`);
  console.log(`Nuevas añadidas: ${nuevasUnicas.length}`);
  console.log(`TOTAL fusionado: ${fusionado.length}`);
  console.log('\n✅ Guardado en: data/locations_fusionado.json');
  console.log('\nPara activar:');
  console.log('  1. Renombrar locations.json -> locations_old.json');
  console.log('  2. Renombrar locations_fusionado.json -> locations.json');
  console.log('  3. Reiniciar backend: node server.js');
}

fusionar().catch(console.error);
