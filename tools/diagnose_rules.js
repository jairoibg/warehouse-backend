import 'dotenv/config';
import xmlrpc from 'xmlrpc';

const ODOO_CONFIG = {
  url: process.env.ODOO_URL,
  db: process.env.ODOO_DB,
  username: process.env.ODOO_USERNAME,
  password: process.env.ODOO_PASSWORD,
};

async function diagnoseRules() {
  console.log(" ⚖️  ANALIZANDO REGLAS DE CLASIFICACIÓN ABC...");
  
  const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });

  try {
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    console.log(" ✅  Conectado.");

    // 1. CONSULTAR LOS PERFILES (El "Cómo")
    console.log("\n 📂  TABLA 1: PERFILES (abc.classification.profile)");
    const profiles = await new Promise((resolve) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'abc.classification.profile', 'search_read', [[]], 
            { limit: 20 }
        ], (err, res) => resolve(res || []));
    });

    profiles.forEach(p => {
        console.log(`   🔹 ID: ${p.id} | Nombre: "${p.name}"`);
        // Mostramos campos clave que puedan contener la lógica
        Object.keys(p).forEach(k => {
            if (['classification_method', 'period', 'calculation_method'].some(term => k.includes(term)) || p[k] === true) {
                 console.log(`      - ${k}: ${p[k]}`);
            }
        });
    });

    // 2. CONSULTAR LOS NIVELES (Los "Umbrales")
    console.log("\n 📏  TABLA 2: NIVELES (abc.classification.level)");
    const levels = await new Promise((resolve) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'abc.classification.level', 'search_read', [[]], 
            { limit: 20 }
        ], (err, res) => resolve(res || []));
    });

    levels.forEach(l => {
        console.log(`   🔸 ID: ${l.id} | Nivel: "${l.name}"`);
        // Buscamos porcentajes o valores numéricos
        Object.keys(l).forEach(k => {
            if (typeof l[k] === 'number' && !k.includes('uid') && !k.includes('id')) {
                console.log(`      - ${k}: ${l[k]}`);
            }
        });
    });

  } catch (error) {
    console.error("Error:", error);
  }
}

diagnoseRules();