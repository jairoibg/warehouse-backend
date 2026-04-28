import 'dotenv/config';
import xmlrpc from 'xmlrpc';

const url = process.env.ODOO_URL;
const db = process.env.ODOO_DATABASE;
const username = process.env.ODOO_USERNAME;
const password = process.env.ODOO_PASSWORD;

if (!url || !db || !username || !password) {
  throw new Error('[test_antiguedad] Faltan variables de entorno ODOO_URL/DATABASE/USERNAME/PASSWORD');
}

async function testAntiguedad(packageName) {
  console.log(`\n🔍 Analizando paquete: ${packageName}`);
  console.log('='.repeat(50));
  
  const common = xmlrpc.createSecureClient({ url: `${url}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${url}/xmlrpc/2/object` });
  
  const uid = await new Promise((resolve, reject) => {
    common.methodCall('authenticate', [db, username, password, {}], (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
  
  // 1. Buscar el paquete
  const packages = await new Promise((resolve, reject) => {
    models.methodCall('execute_kw', [
      db, uid, password,
      'stock.quant.package', 'search_read',
      [[['name', '=', packageName]]],
      { fields: ['id', 'name', 'create_date'] }
    ], (err, res) => err ? reject(err) : resolve(res));
  });
  
  if (packages.length === 0) {
    console.log('❌ Paquete no encontrado');
    return;
  }
  
  const pkg = packages[0];
  console.log(`📦 Paquete ID: ${pkg.id}`);
  console.log(`📅 Create Date (NO USAR): ${pkg.create_date}`);
  
  // 2. Buscar movimientos donde este paquete es el resultado
  const moveLines = await new Promise((resolve, reject) => {
    models.methodCall('execute_kw', [
      db, uid, password,
      'stock.move.line', 'search_read',
      [[['result_package_id', '=', pkg.id]]],
      { 
        fields: ['id', 'picking_id', 'date', 'state'],
        order: 'date asc'
      }
    ], (err, res) => err ? reject(err) : resolve(res));
  });
  
  console.log(`\n📋 Movimientos encontrados: ${moveLines.length}`);
  
  if (moveLines.length === 0) {
    console.log('⚠️ No hay movimientos para este paquete');
    return;
  }
  
  // 3. Obtener detalles de cada picking
  const pickingIds = [...new Set(
    moveLines
      .filter(ml => ml.picking_id && ml.picking_id[0])
      .map(ml => ml.picking_id[0])
  )];

  if (pickingIds.length === 0) {
    console.log('⚠️ No hay pickings válidos para este paquete');
    return;
  }
  
  const pickings = await new Promise((resolve, reject) => {
    models.methodCall('execute_kw', [
      db, uid, password,
      'stock.picking', 'search_read',
      [[['id', 'in', pickingIds]]],
      { 
        fields: ['id', 'name', 'picking_type_id', 'date_done', 'state'],
        order: 'date_done asc'
      }
    ], (err, res) => err ? reject(err) : resolve(res));
  });
  
  console.log('\n📄 Pickings asociados:');
  pickings.forEach(p => {
    const tipoOp = p.picking_type_id ? p.picking_type_id[1] : 'N/A';
    console.log(`   - ${p.name} | Tipo: ${tipoOp} | Fecha: ${p.date_done} | Estado: ${p.state}`);
  });
  
  // 4. Buscar el picking correcto (prioridad: DES > PAQ)
  let pickingAntigueadad = null;
  
  // Primero buscar DES (descarga contenedor)
  pickingAntigueadad = pickings.find(p => {
    const tipo = p.picking_type_id ? p.picking_type_id[1].toUpperCase() : '';
    return tipo.includes('DESCARGA') || tipo.includes('DES');
  });
  
  // Si no hay DES, buscar PAQ o "Crear paquetes" (todas las marcas)
  if (!pickingAntigueadad) {
    pickingAntigueadad = pickings.find(p => {
      const nombre = p.name.toUpperCase();
      const tipo = p.picking_type_id ? p.picking_type_id[1].toUpperCase() : '';
      
      // Buscar en nombre del picking
      const nombreMatch = nombre.includes('PAQ') || 
                          nombre.includes('BDPQ') || 
                          nombre.includes('GDPQ') || 
                          nombre.includes('WHPQ') ||
                          nombre.includes('WDPQ');
      
      // Buscar en tipo de operación (todas las marcas)
      const tipoMatch = tipo.includes('CREAR PAQUETE') ||
                        tipo.includes('CREAR PAQUETES');
      
      return nombreMatch || tipoMatch;
    });
  }
  
  // Si no hay ninguno, usar el primero
  if (!pickingAntigueadad && pickings.length > 0) {
    pickingAntigueadad = pickings[0];
    console.log('\n⚠️ No se encontró DES ni PAQ, usando el primer picking');
  }
  
  if (pickingAntigueadad) {
    const fechaEntrada = new Date(pickingAntigueadad.date_done);
    const hoy = new Date();
    const diasAlmacen = Math.floor((hoy - fechaEntrada) / (1000 * 60 * 60 * 24));
    
    console.log('\n✅ RESULTADO:');
    console.log(`   Picking seleccionado: ${pickingAntigueadad.name}`);
    console.log(`   Tipo operación: ${pickingAntigueadad.picking_type_id[1]}`);
    console.log(`   Fecha entrada almacén: ${pickingAntigueadad.date_done}`);
    console.log(`   📆 DÍAS EN ALMACÉN: ${diasAlmacen} días`);
  }
}

// Ejecutar con paquetes de prueba
const paquetesPrueba = process.argv.slice(2);

if (paquetesPrueba.length === 0) {
  console.log('Uso: node test_antiguedad.mjs PAQUETE1 PAQUETE2');
  console.log('Ejemplo: node test_antiguedad.mjs FGD00012345 DFK00054321');
} else {
  (async () => {
    for (const pkg of paquetesPrueba) {
      await testAntiguedad(pkg);
    }
  })();
}
