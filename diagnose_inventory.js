import xmlrpc from 'xmlrpc';
import { getOdooConfig } from './src/config/odooConfig.js';

// Obtener configuración de variables de entorno
const ODOO_CONFIG = getOdooConfig();

async function diagnoseInventory() {
    console.log("📡 Conectando a Odoo para mapear el Inventario...");

    const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
    const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });

    try {
        // 1. Autenticación
        const uid = await new Promise((resolve, reject) => {
            common.methodCall('authenticate', [
                ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
            ], (err, res) => err ? reject(err) : resolve(res));
        });

        if (!uid) throw new Error("Fallo de autenticación.");
        console.log("✅ Autenticado. ID de usuario:", uid);

        // 2. Buscar todas las tablas que empiecen por 'stock.'
        console.log("🔍 Escaneando modelos del sistema (ir.model)...");
        
        const tables = await new Promise((resolve, reject) => {
            models.methodCall('execute_kw', [
                ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
                'ir.model', 'search_read',
                [[['model', '=like', 'stock.%']]], // Filtro: Tablas que empiezan por "stock."
                { fields: ['model', 'name'], limit: 200 }
            ], (err, res) => err ? reject(err) : resolve(res));
        });

        // 3. Mostrar resultados limpios
        console.log(`\n📦 SE HAN ENCONTRADO ${tables.length} TABLAS DE INVENTARIO:\n`);
        
        // Agrupamos por "familia" para que sea legible
        const groups = {
            'stock.quant': [],      // Stock físico real
            'stock.picking': [],    // Albaranes / Operaciones
            'stock.move': [],       // Movimientos
            'stock.location': [],   // Ubicaciones
            'stock.lot': [],        // Lotes / Series
            'otros': []
        };

        tables.sort((a, b) => a.model.localeCompare(b.model)).forEach(t => {
            if (t.model.startsWith('stock.quant')) groups['stock.quant'].push(t);
            else if (t.model.startsWith('stock.picking')) groups['stock.picking'].push(t);
            else if (t.model.startsWith('stock.move')) groups['stock.move'].push(t);
            else if (t.model.startsWith('stock.location')) groups['stock.location'].push(t);
            else if (t.model.startsWith('stock.lot') || t.model.startsWith('stock.production.lot')) groups['stock.lot'].push(t);
            else groups['otros'].push(t);
        });

        // Imprimir bonito
        const printGroup = (name, list) => {
            if (list.length === 0) return;
            console.log(`🔹 FAMILIA: ${name.toUpperCase()}`);
            list.forEach(t => console.log(`   - ${t.model.padEnd(35)} [${t.name}]`));
            console.log("");
        };

        printGroup('Stock Real (Quants)', groups['stock.quant']);
        printGroup('Albaranes (Pickings)', groups['stock.picking']);
        printGroup('Movimientos (Moves)', groups['stock.move']);
        printGroup('Ubicaciones (Locations)', groups['stock.location']);
        printGroup('Lotes (Lots)', groups['stock.lot']);
        printGroup('Otras Tablas / Configuración', groups['otros']);

    } catch (error) {
        console.error("❌ Error fatal:", error);
    }
}

diagnoseInventory();