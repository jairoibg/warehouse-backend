import 'dotenv/config';
import xmlrpc from 'xmlrpc';

// ==================================================================================
// 🔎 ESCRIBE AQUÍ LO QUE QUIERES BUSCAR (PARTE DEL CÓDIGO)
// ==================================================================================
const SEARCH_TERM = 'COSH542021'; // <--- Ponemos solo la parte principal para ver qué sale

async function findProduct() {
    console.log(`🔎 BUSCANDO COINCIDENCIAS PARA: "${SEARCH_TERM}"...`);
    
    const ODOO_CONFIG = {
        url: process.env.ODOO_URL,
        db: process.env.ODOO_DB,
        username: process.env.ODOO_USERNAME,
        password: process.env.ODOO_PASSWORD,
    };

    const urlObj = new URL(ODOO_CONFIG.url);
    const common = xmlrpc.createSecureClient({ host: urlObj.hostname, port: 443, path: '/xmlrpc/2/common' });
    const models = xmlrpc.createSecureClient({ host: urlObj.hostname, port: 443, path: '/xmlrpc/2/object' });

    const uid = await new Promise((resolve, reject) => {
        common.methodCall('authenticate', [ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}], (e, r) => e ? reject(e) : resolve(r));
    });

    // Buscamos productos donde el código O el nombre contengan el texto (ilike)
    const products = await new Promise((resolve, reject) => {
        models.methodCall('execute_kw', [ODOO_CONFIG.db, uid, ODOO_CONFIG.password, 'product.product', 'search_read', [
            ['|', 
                ['default_code', 'ilike', SEARCH_TERM], 
                ['name', 'ilike', SEARCH_TERM]
            ]
        ], { 
            fields: ['id', 'default_code', 'name', 'product_template_variant_value_ids'], 
            limit: 20 
        }], (e, r) => e ? reject(e) : resolve(r));
    });

    if (products.length === 0) {
        console.log("❌ No se encontró nada parecido.");
    } else {
        console.log(`✅ ¡ENCONTRADOS ${products.length} PRODUCTOS!`);
        console.log(`   Copia la referencia EXACTA de la columna izquierda:\n`);
        console.log(`   REFERENCIA EXACTA (default_code)  |  NOMBRE`);
        console.log(`   ----------------------------------------------------------------`);
        products.forEach(p => {
            // A veces el código es false o null
            const code = p.default_code ? p.default_code : "SIN_REF";
            console.log(`   ${code.padEnd(32)}  |  ${p.name}`);
        });
        console.log(`   ----------------------------------------------------------------`);
    }
}

findProduct().catch(console.error);