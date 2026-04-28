import 'dotenv/config';
import xmlrpc from 'xmlrpc';
import fs from 'fs/promises';

const url = process.env.ODOO_URL;
const db = process.env.ODOO_DATABASE;
const username = process.env.ODOO_USERNAME;
const password = process.env.ODOO_PASSWORD;

if (!url || !db || !username || !password) {
  throw new Error('[test_antiguedad_masivo] Faltan variables de entorno ODOO_URL/DATABASE/USERNAME/PASSWORD');
}

const models = xmlrpc.createSecureClient({ url: `${url}/xmlrpc/2/object` });

async function authenticate() {
  const common = xmlrpc.createSecureClient({ url: `${url}/xmlrpc/2/common` });
  return new Promise((resolve, reject) => {
    common.methodCall('authenticate', [db, username, password, {}], (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

async function searchRead(uid, model, domain, fields, limit = 50000) {
  return new Promise((resolve, reject) => {
    models.methodCall('execute_kw', [
      db, uid, password,
      model, 'search_read',
      [domain],
      { fields, limit }
    ], (err, res) => err ? reject(err) : resolve(res));
  });
}

async function main() {
  const startTime = Date.now();
  console.log('🚀 Iniciando cálculo masivo de antigüedades...\n');

  // 1. Cargar paquetes del locations.json
  console.log('📂 Cargando paquetes del locations.json...');
  const locationsRaw = await fs.readFile('data/locations.json', 'utf-8');
  const locations = JSON.parse(locationsRaw);
  
  // Extraer todos los paquetes únicos
  const allPackages = new Set();
  locations.forEach(loc => {
    if (loc.packages && Array.isArray(loc.packages)) {
      loc.packages.forEach(pkg => {
        if (pkg.packageId) allPackages.add(pkg.packageId);
        if (pkg.packageName) allPackages.add(pkg.packageName);
      });
    }
  });
  
  console.log(`📦 Paquetes únicos encontrados: ${allPackages.size}`);
  
  if (allPackages.size === 0) {
    console.log('⚠️ No hay paquetes en el locations.json');
    return;
  }

  // 2. Autenticar
  console.log('\n🔐 Autenticando en Odoo...');
  const uid = await authenticate();
  console.log(`✅ Autenticado (UID: ${uid})`);

  // 3. Obtener IDs de paquetes por nombre
  console.log('\n📋 Obteniendo IDs de paquetes...');
  const packageNames = [...allPackages].filter(p => typeof p === 'string' && p.length > 0);
  
  const packagesData = await searchRead(uid, 'stock.quant.package', 
    [['name', 'in', packageNames]], 
    ['id', 'name', 'create_date']
  );
  console.log(`✅ Paquetes encontrados en Odoo: ${packagesData.length}`);
  
  const packageIdToName = {};
  const packageNameToId = {};
  packagesData.forEach(p => {
    packageIdToName[p.id] = p.name;
    packageNameToId[p.name] = p.id;
  });

  // 4. Obtener TODOS los move lines de esos paquetes (en batches)
  console.log('\n📋 Obteniendo movimientos de paquetes...');
  const packageIds = packagesData.map(p => p.id);
  
  // Hacer en batches de 1000
  const batchSize = 1000;
  const allMoveLines = [];
  
  for (let i = 0; i < packageIds.length; i += batchSize) {
    const batch = packageIds.slice(i, i + batchSize);
    const moveLines = await searchRead(uid, 'stock.move.line',
      [['result_package_id', 'in', batch]],
      ['result_package_id', 'picking_id']
    );
    allMoveLines.push(...moveLines);
    console.log(`   ... procesados ${Math.min(i + batchSize, packageIds.length)} / ${packageIds.length} paquetes`);
  }
  
  console.log(`✅ Move lines encontrados: ${allMoveLines.length}`);

  // 5. Extraer picking IDs únicos
  const pickingIds = [...new Set(
    allMoveLines
      .filter(ml => ml.picking_id && ml.picking_id[0])
      .map(ml => ml.picking_id[0])
  )];
  console.log(`\n📋 Pickings únicos a consultar: ${pickingIds.length}`);

  // 6. Obtener datos de pickings (en batches)
  console.log('📋 Obteniendo datos de pickings...');
  const allPickings = [];
  
  for (let i = 0; i < pickingIds.length; i += batchSize) {
    const batch = pickingIds.slice(i, i + batchSize);
    const pickings = await searchRead(uid, 'stock.picking',
      [['id', 'in', batch]],
      ['id', 'name', 'picking_type_id', 'date_done', 'state']
    );
    allPickings.push(...pickings);
    console.log(`   ... procesados ${Math.min(i + batchSize, pickingIds.length)} / ${pickingIds.length} pickings`);
  }
  
  console.log(`✅ Pickings obtenidos: ${allPickings.length}`);

  // 7. Crear mapa de picking por ID
  const pickingById = {};
  allPickings.forEach(p => {
    pickingById[p.id] = p;
  });

  // 8. Crear mapa de movelines por paquete
  const moveLinesByPackage = {};
  allMoveLines.forEach(ml => {
    if (ml.result_package_id && ml.picking_id) {
      const pkgId = ml.result_package_id[0];
      if (!moveLinesByPackage[pkgId]) moveLinesByPackage[pkgId] = [];
      moveLinesByPackage[pkgId].push(ml.picking_id[0]);
    }
  });

  // 9. Calcular antigüedad para cada paquete
  console.log('\n🧮 Calculando antigüedades...');
  const antiguedades = {};
  let conDES = 0;
  let conPAQ = 0;
  let sinFecha = 0;
  const hoy = new Date();

  packagesData.forEach(pkg => {
    const pickingIdsForPkg = moveLinesByPackage[pkg.id] || [];
    const pickingsForPkg = pickingIdsForPkg
      .map(id => pickingById[id])
      .filter(Boolean)
      .sort((a, b) => new Date(a.date_done) - new Date(b.date_done));

    // Buscar DES primero
    let pickingAntigueadad = pickingsForPkg.find(p => {
      const tipo = p.picking_type_id ? p.picking_type_id[1].toUpperCase() : '';
      return tipo.includes('DESCARGA') || tipo.includes('DES');
    });

    if (pickingAntigueadad) {
      conDES++;
    } else {
      // Buscar PAQ o "Crear paquetes"
      pickingAntigueadad = pickingsForPkg.find(p => {
        const nombre = p.name.toUpperCase();
        const tipo = p.picking_type_id ? p.picking_type_id[1].toUpperCase() : '';
        
        const nombreMatch = nombre.includes('PAQ') || 
                            nombre.includes('BDPQ') || 
                            nombre.includes('GDPQ') || 
                            nombre.includes('WHPQ') ||
                            nombre.includes('WDPQ');
        
        const tipoMatch = tipo.includes('CREAR PAQUETE') ||
                          tipo.includes('CREAR PAQUETES');
        
        return nombreMatch || tipoMatch;
      });
      
      if (pickingAntigueadad) conPAQ++;
    }

    if (pickingAntigueadad && pickingAntigueadad.date_done) {
      const fechaEntrada = new Date(pickingAntigueadad.date_done);
      const dias = Math.floor((hoy - fechaEntrada) / (1000 * 60 * 60 * 24));
      
      antiguedades[pkg.name] = {
        packageId: pkg.id,
        packageName: pkg.name,
        fechaEntrada: pickingAntigueadad.date_done,
        diasEnAlmacen: dias,
        pickingOrigen: pickingAntigueadad.name,
        tipoOperacion: pickingAntigueadad.picking_type_id ? pickingAntigueadad.picking_type_id[1] : 'N/A',
        metodo: pickingAntigueadad.name.toUpperCase().includes('DES') || 
                (pickingAntigueadad.picking_type_id && pickingAntigueadad.picking_type_id[1].toUpperCase().includes('DESCARGA')) 
                ? 'DES' : 'PAQ'
      };
    } else {
      sinFecha++;
      // Fallback: usar create_date del paquete
      const fechaCreate = new Date(pkg.create_date);
      const dias = Math.floor((hoy - fechaCreate) / (1000 * 60 * 60 * 24));
      
      antiguedades[pkg.name] = {
        packageId: pkg.id,
        packageName: pkg.name,
        fechaEntrada: pkg.create_date,
        diasEnAlmacen: dias,
        pickingOrigen: 'N/A (usando create_date)',
        tipoOperacion: 'N/A',
        metodo: 'CREATE_DATE'
      };
    }
  });

  // 10. Guardar resultados
  const outputFile = 'data/antiguedades_paquetes.json';
  await fs.writeFile(outputFile, JSON.stringify(antiguedades, null, 2));

  // 11. Mostrar resumen
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 RESUMEN');
  console.log('='.repeat(60));
  console.log(`Total paquetes procesados: ${packagesData.length}`);
  console.log(`Con fecha DES (Descarga): ${conDES}`);
  console.log(`Con fecha PAQ (Crear paquete): ${conPAQ}`);
  console.log(`Sin fecha (usando create_date): ${sinFecha}`);
  console.log(`\n⏱️ Tiempo total: ${elapsed} segundos`);
  console.log(`\n✅ Guardado en: ${outputFile}`);
  
  // Mostrar algunos ejemplos
  console.log('\n📋 Ejemplos de antigüedades calculadas:');
  const ejemplos = Object.values(antiguedades).slice(0, 5);
  ejemplos.forEach(e => {
    console.log(`   ${e.packageName}: ${e.diasEnAlmacen} días (${e.metodo})`);
  });
}

main().catch(console.error);
