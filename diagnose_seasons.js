import xmlrpc from 'xmlrpc';
import { getOdooConfig } from './src/config/odooConfig.js';

// Obtener configuración de variables de entorno
const ODOO_CONFIG = getOdooConfig();

async function diagnose() {
  console.log(" 🕵️  Conectando para buscar el campo 'Temporada'...");
  
  const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });

  try {
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    console.log(" ✅  Conectado. Escaneando campos en 'product.product'...");

    // 1. Obtener todos los campos del producto
    const fields = await new Promise((resolve) => {
      models.methodCall('execute_kw', [
        ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
        'product.product', 'fields_get', [], 
        { attributes: ['string', 'type', 'name'] }
      ], (err, res) => resolve(res));
    });

    // 2. Filtrar candidatos probables
    const keywords = ['season', 'temporada', 'estacion', 'coleccion', 'collection', 'year', 'ano'];
    const candidates = Object.keys(fields).filter(key => {
        const label = (fields[key].string || "").toLowerCase();
        const name = key.toLowerCase();
        return keywords.some(kw => label.includes(kw) || name.includes(kw));
    });

    console.log("\n 📋  CAMPOS CANDIDATOS ENCONTRADOS:");
    if (candidates.length === 0) {
        console.log(" ⚠️  No he encontrado campos obvios. Tendremos que mirar los Atributos.");
    } else {
        candidates.forEach(key => {
            console.log(`   🔹 [${key}]: "${fields[key].string}" (Tipo: ${fields[key].type})`);
        });
    }

    // 3. Mirar si es un ATRIBUTO (Variante)
    console.log("\n 🔍  Buscando en Atributos de Producto...");
    const attributes = await new Promise((resolve) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'product.attribute', 'search_read', 
            [[['name', 'ilike', 'temporada'], ['name', 'ilike', 'season'], '|']], // Busca nombre parecido
            { fields: ['name', 'id'] }
        ], (err, res) => resolve(res || []));
    });

    if (attributes.length > 0) {
        console.log("   👉  ATRIBUTOS ENCONTRADOS (Esto es muy probable):");
        attributes.forEach(a => console.log(`       - ID: ${a.id} | Nombre: ${a.name}`));
    } else {
        console.log("   ❌  No parece ser un atributo estándar.");
    }

    // 4. Sacar una muestra real de un producto para ver dónde están los datos
    console.log("\n 📦  Muestra de datos de 1 producto (para ver valores reales):");
    const sample = await new Promise((resolve) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'product.product', 'search_read', [[]], 
            { limit: 1 } // Trae todo lo que tenga el producto
        ], (err, res) => resolve(res ? res[0] : {}));
    });
    
    // Imprimimos solo las claves que tengan valor y parezcan relevantes
    Object.keys(sample).forEach(k => {
        if (candidates.includes(k) || k.includes('x_')) {
            console.log(`   > ${k}: ${sample[k]}`);
        }
    });

  } catch (error) {
    console.error("Error:", error);
  }
}

diagnose();