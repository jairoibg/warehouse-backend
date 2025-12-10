import 'dotenv/config';
import xmlrpc from 'xmlrpc';

// ==================================================================================
// CONFIGURACIÓN RÁPIDA
// ==================================================================================
const ODOO_CONFIG = {
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
};

// ==================================================================================
// UTILIDADES DE TEMPORADA (Misma lógica que ICC Engine)
// ==================================================================================
function parseSeason(seasonStr) {
    if (!seasonStr || typeof seasonStr !== 'string') return null;
    const match = seasonStr.match(/^([IV])(\d{2})$/i);
    if (!match) return null;
    const type = match[1].toUpperCase();
    const year = parseInt(match[2], 10);
    const baseYear = 17;
    return ((year - baseYear) * 2) + (type === 'V' ? 1 : 0);
}

function getCurrentSeasonOrdinal() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear() % 100;
    // Si estamos en V26 o I26... (simplificado para obtener el ordinal actual)
    let currentStr = (month >= 2 && month <= 7) ? `V${year}` : (month >= 8 ? `I${year + 1}` : `I${year}`);
    return parseSeason(currentStr);
}

// ==================================================================================
// SCRIPT PRINCIPAL
// ==================================================================================
async function analyzeOldStockPrices() {
    console.log('💀 ANÁLISIS DE PRECIOS: STOCK ZOMBIE (+4 TEMPORADAS)');
    console.log('===================================================\n');

    // 1. Conexión
    const urlObj = new URL(ODOO_CONFIG.url);
    const common = xmlrpc.createSecureClient({ host: urlObj.hostname, port: 443, path: '/xmlrpc/2/common' });
    const models = xmlrpc.createSecureClient({ host: urlObj.hostname, port: 443, path: '/xmlrpc/2/object' });

    const uid = await new Promise((resolve, reject) => {
        common.methodCall('authenticate', [ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}], (e, r) => e ? reject(e) : resolve(r));
    });

    console.log('✅ Conectado. Buscando productos antiguos...\n');

    // 2. Obtener Stock
    const stockQuants = await new Promise((resolve, reject) => {
        models.methodCall('execute_kw', [ODOO_CONFIG.db, uid, ODOO_CONFIG.password, 'stock.quant', 'search_read', [
            [['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]
        ], { fields: ['product_id', 'quantity', 'value'] }], (e, r) => e ? reject(e) : resolve(r));
    });

    // 3. Obtener Productos y Temporadas
    const productIds = [...new Set(stockQuants.map(q => q.product_id[0]))];
    const products = await new Promise((resolve, reject) => {
        models.methodCall('execute_kw', [ODOO_CONFIG.db, uid, ODOO_CONFIG.password, 'product.product', 'search_read', [
            [['id', 'in', productIds]]
        ], { fields: ['id', 'default_code', 'sale_season_id', 'standard_price'] }], (e, r) => e ? reject(e) : resolve(r));
    });

    // 4. Procesar Datos
    const currentOrdinal = getCurrentSeasonOrdinal();
    let oldStockData = [];
    let totalValue = 0;
    let totalUnits = 0;

    const productMap = {};
    products.forEach(p => productMap[p.id] = p);

    stockQuants.forEach(quant => {
        const product = productMap[quant.product_id[0]];
        if (!product || !product.sale_season_id) return;

        const seasonStr = product.sale_season_id[1];
        const prodOrdinal = parseSeason(seasonStr);
        
        // Calcular distancia
        const distance = currentOrdinal - prodOrdinal;

        // FILTRO: Solo +4 temporadas
        if (distance >= 4) {
            const unitCost = product.standard_price;
            const value = quant.value > 0 ? quant.value : (quant.quantity * unitCost);
            
            oldStockData.push({
                name: product.default_code,
                season: seasonStr,
                qty: quant.quantity,
                unitCost: unitCost,
                totalValue: value
            });

            totalValue += value;
            totalUnits += quant.quantity;
        }
    });

    // 5. Cálculos Finales
    if (totalUnits === 0) {
        console.log("¡Buenas noticias! No se ha encontrado stock antiguo (+4 temporadas).");
        return;
    }

    const averageCost = totalValue / totalUnits;
    
    // Ordenar para encontrar los más caros y baratos
    oldStockData.sort((a, b) => b.unitCost - a.unitCost);

    console.log(`📊 RESULTADOS DEL ANÁLISIS:`);
    console.log(`   ---------------------------------------------`);
    console.log(`   📦 Unidades totales antiguas:   ${totalUnits.toLocaleString()} uds`);
    console.log(`   💰 Valor total atrapado:        €${totalValue.toLocaleString('es-ES', {minimumFractionDigits: 2})}`);
    console.log(`   🏷️  PRECIO DE COSTE MEDIO:       €${averageCost.toFixed(2)} / unidad`);
    console.log(`   ---------------------------------------------\n`);

    console.log(`🧐 DESGLOSE DE PRODUCTOS ANTIGUOS:`);
    console.log(`   Top 5 Más Caros (Coste Unitario):`);
    oldStockData.slice(0, 5).forEach(p => {
        console.log(`     - [${p.season}] ${p.name}: €${p.unitCost.toFixed(2)} (${p.qty} uds)`);
    });

    console.log(`\n   Top 5 Más Baratos (Coste Unitario):`);
    oldStockData.slice(-5).reverse().forEach(p => {
        console.log(`     - [${p.season}] ${p.name}: €${p.unitCost.toFixed(2)} (${p.qty} uds)`);
    });

    console.log(`\n💡 CONCLUSIÓN RÁPIDA:`);
    if (averageCost > 20) {
        console.log(`   Tu stock antiguo es CARO (€${averageCost.toFixed(2)} avg). Es capital atrapado de alto valor.`);
        console.log(`   Recomendación: Venta Flash VIP o Outlet Privado. Recuperar liquidez es prioridad.`);
    } else {
        console.log(`   Tu stock antiguo es BARATO (€${averageCost.toFixed(2)} avg). Probablemente restos de series.`);
        console.log(`   Recomendación: Packs, donación (beneficio fiscal) o venta a peso/lote.`);
    }
}

analyzeOldStockPrices().catch(console.error);