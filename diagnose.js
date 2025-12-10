import xmlrpc from 'xmlrpc';

// TUS DATOS
const ODOO_CONFIG = {
  url: 'https://professional.illice.com',
  db: 'illice_a0cc8584',
  username: 'j.bernabe@illice.com',
  password: '98b68f64a4ee2fd5362f16f3b0427a629877f80f',
};

async function diagnose() {
    const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });

    // 1. Autenticar
    const uid = await new Promise((resolve, reject) => {
        common.methodCall('authenticate', [
            ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
        ], (err, res) => err ? reject(err) : resolve(res));
    });

    console.log("✅ Conectado. Buscando pistas sobre 'ABC'...");

    // 2. Buscar en los campos de PRODUCTO (product.product)
    console.log("\n🔎 Analizando campos en 'product.product'...");
    const fieldsProduct = await new Promise((resolve) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'product.product', 'fields_get', [], { attributes: ['string', 'type'] }
        ], (err, res) => resolve(res));
    });

    const abcFields = Object.keys(fieldsProduct).filter(k => 
        k.toLowerCase().includes('abc') || 
        k.toLowerCase().includes('clasif') || 
        k.toLowerCase().includes('class')
    );
    
    if (abcFields.length > 0) {
        console.log("   👉 POSIBLES CAMPOS EN PRODUCTO:", abcFields);
    } else {
        console.log("   ❌ No hay campos 'ABC' en el producto directamente.");
    }

    // 3. Buscar si existe el MODELO separado (Tablas custom)
    console.log("\n🔎 Buscando tablas personalizadas (Models)...");
    // Intentamos listar modelos que contengan "abc"
    const searchModels = await new Promise((resolve) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'ir.model', 'search_read', 
            [[['model', 'ilike', 'abc']]], 
            { fields: ['model', 'name'] }
        ], (err, res) => resolve(res));
    });

    if (searchModels && searchModels.length > 0) {
        console.log("   👉 TABLAS ENCONTRADAS:");
        searchModels.forEach(m => console.log(`      - Nombre Técnico: '${m.model}' (Nombre: ${m.name})`));
    } else {
        console.log("   ❌ No se encontraron tablas con 'abc' en el nombre.");
    }
}

diagnose().catch(console.error);