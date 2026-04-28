import 'dotenv/config';
import xmlrpc from 'xmlrpc';
import fs from 'fs/promises';

const url = process.env.ODOO_URL;
const db = process.env.ODOO_DATABASE;
const username = process.env.ODOO_USERNAME;
const password = process.env.ODOO_PASSWORD;

if (!url || !db || !username || !password) {
  throw new Error('[ubicaciones] Faltan variables de entorno ODOO_URL/DATABASE/USERNAME/PASSWORD');
}

async function extractLocations() {
  console.log("Conectando a Odoo...");
  
  const common = xmlrpc.createSecureClient(`${url}/xmlrpc/2/common`);
  const uid = await new Promise((resolve, reject) => {
    common.methodCall('authenticate', [db, username, password, {}], (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
  
  console.log(`Autenticado como UID: ${uid}`);
  
  const models = xmlrpc.createSecureClient(`${url}/xmlrpc/2/object`);
  
  const locations = await new Promise((resolve, reject) => {
    models.methodCall('execute_kw', [
      db, uid, password,
      'stock.location', 'search_read',
      [[['complete_name', 'like', '%CLA-%']]],
      { fields: ['id', 'name', 'complete_name'], limit: 10000 }
    ], (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
  
  console.log(`Encontradas ${locations.length} ubicaciones en Odoo`);
  
  const filtered = locations.filter(l => {
    const name = l.complete_name;
    if (name.includes('Storage')) return true;
    if (name.includes('EXTB2B')) {
      const match = name.match(/CLA-(\d{3})/);
      if (match) {
        const aisle = parseInt(match[1], 10);
        return (aisle >= 1 && aisle <= 21) || aisle === 31;
      }
    }
    return false;
  });
  
  console.log(`Filtradas: ${filtered.length}`);
  
  const result = filtered.map(loc => {
    const fullId = loc.complete_name.replace(/\s/g, '');
    const match = fullId.match(/CLA-(\d{3})-(\d{2})-(\d{2})-(\d{2})/);
    if (!match) return null;
    
    const [_, aisle, block, level, position] = match;
    
    let brand = "GENERIC";
    if (fullId.includes('BD')) brand = "BLACK";
    else if (fullId.includes('GD')) brand = "GOLD";
    else if (fullId.includes('WD') || fullId.includes('WH')) brand = "WHITE";
    
    return {
      id: fullId,
      aisle,
      block,
      level,
      position,
      totalStock: 0,
      totalReserved: 0,
      status: "FREE",
      packages: [],
      brand,
      occupancyPercentage: 0,
      velocityScore: 0,
      market: null
    };
  }).filter(Boolean);
  
  console.log(`Procesadas: ${result.length} ubicaciones`);
  
  await fs.writeFile('data/locations_test.json', JSON.stringify(result, null, 2));
  console.log("Guardado en data/locations_test.json");
  
  const b2c = result.filter(l => l.id.includes('Storage'));
  const b2b = result.filter(l => l.id.includes('EXTB2B'));
  console.log(`B2C: ${b2c.length}, B2B: ${b2b.length}`);
}

extractLocations().catch(console.error);
