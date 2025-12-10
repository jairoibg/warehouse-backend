import 'dotenv/config';
import xmlrpc from 'xmlrpc';

// ==================================================================================
// CONFIGURACIÓN: REFERENCIA A BUSCAR
// ==================================================================================
const TARGET_REF = 'COSH542021'; // <--- CAMBIA ESTO SI QUIERES BUSCAR OTRO

// ==================================================================================
// MOTOR LÓGICO ICC (Misma configuración que el motor general)
// ==================================================================================
const ICC_CONFIG = {
    BASE_ANNUAL_RATE: { capitalCost: 0.10, obsolescenceBase: 0.06, riskService: 0.02 }, // Total 18% base
    SEASON_DEPRECIATION_ANNUAL: {
        current: 0.00, previous_1: 0.06, previous_2: 0.12, previous_3: 0.18, previous_4_plus: 0.24
    },
    SEASON_ORDER: ['I', 'V']
};

// ==================================================================================
// FUNCIONES DE CÁLCULO
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

function getCurrentSeason() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear() % 100;
    if (month >= 2 && month <= 7) return `V${year}`;
    else if (month >= 8) return `I${year + 1}`;
    else return `I${year}`;
}

function calculateRate(productSeason, currentSeason) {
    const prodOrd = parseSeason(productSeason);
    const currOrd = parseSeason(currentSeason);
    
    // Si no tiene temporada, asumimos coste base sin penalización (conservador)
    // O podrías asumir penalización máxima si prefieres. Aquí uso base.
    if (prodOrd === null) return { rate: 0.18, distance: 'Desconocida', penalty: 0 };

    const distance = currOrd - prodOrd;
    let penalty = 0;

    if (distance <= 0) penalty = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.current;
    else if (distance === 1) penalty = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_1;
    else if (distance === 2) penalty = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_2;
    else if (distance === 3) penalty = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_3;
    else penalty = ICC_CONFIG.SEASON_DEPRECIATION_ANNUAL.previous_4_plus;

    const base = 0.18; // 10 + 6 + 2
    return { rate: base + penalty, distance: distance, penalty: penalty };
}

// ==================================================================================
// SCRIPT PRINCIPAL
// ==================================================================================
async function analyzeProduct() {
    console.log(`🔎 BUSCANDO PRODUCTO: ${TARGET_REF}`);
    console.log('===================================================');

    // 1. Conexión Odoo
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

    // 2. Buscar Producto
    const products = await new Promise((resolve, reject) => {
        models.methodCall('execute_kw', [ODOO_CONFIG.db, uid, ODOO_CONFIG.password, 'product.product', 'search_read', [
            [['default_code', '=', TARGET_REF]]
        ], { fields: ['id', 'name', 'default_code', 'standard_price', 'list_price', 'sale_season_id'] }], (e, r) => e ? reject(e) : resolve(r));
    });

    if (products.length === 0) {
        console.error("❌ ERROR: No se encontró ningún producto con esa referencia.");
        return;
    }
    const product = products[0];

    // 3. Buscar Stock Real
    const quants = await new Promise((resolve, reject) => {
        models.methodCall('execute_kw', [ODOO_CONFIG.db, uid, ODOO_CONFIG.password, 'stock.quant', 'search_read', [
            [['product_id', '=', product.id], ['location_id.usage', '=', 'internal'], ['quantity', '>', 0]]
        ], { fields: ['quantity', 'location_id'] }], (e, r) => e ? reject(e) : resolve(r));
    });

    const totalStock = quants.reduce((sum, q) => sum + q.quantity, 0);
    const locations = [...new Set(quants.map(q => q.location_id[1]))]; // Nombres de ubicaciones

    // 4. Cálculos Financieros
    const currentSeason = getCurrentSeason();
    const productSeason = product.sale_season_id ? product.sale_season_id[1] : "N/A";
    const unitCost = product.standard_price;
    const totalValue = totalStock * unitCost;

    const metrics = calculateRate(productSeason, currentSeason);
    const annualRate = metrics.rate;
    const monthlyRate = annualRate / 12;

    const costPerUnitMonth = unitCost * monthlyRate;
    const totalMonthlyCost = totalValue * monthlyRate;
    const dailyCost = totalMonthlyCost / 30;

    // 5. Informe Final
    console.log(`\n📋 FICHA TÉCNICA FINANCIERA`);
    console.log(`───────────────────────────────────────────────────`);
    console.log(`📦 Producto:       ${product.name}`);
    console.log(`🔑 Referencia:     ${product.default_code}`);
    console.log(`📅 Temporada:      ${productSeason} (Actual: ${currentSeason})`);
    console.log(`⏳ Antigüedad:     ${metrics.distance} temporadas de diferencia`);
    console.log(`───────────────────────────────────────────────────`);
    
    console.log(`\n💰 DATOS ECONÓMICOS (ODOO)`);
    console.log(`   - Coste de compra (Unitario):  €${unitCost.toFixed(2)}`);
    console.log(`   - Precio de venta (PVP):       €${product.list_price.toFixed(2)}`);
    console.log(`   - Stock Físico Total:          ${totalStock} unidades`);
    console.log(`   - Capital Inmovilizado:        €${totalValue.toLocaleString('es-ES', {minimumFractionDigits: 2})}`);
    console.log(`   - Ubicaciones:                 ${locations.length > 0 ? locations.join(', ') : 'Ninguna'}`);

    console.log(`\n🧮 ANÁLISIS DE COSTES (ICC)`);
    console.log(`   - Tasa aplicada anual:         ${(annualRate * 100).toFixed(0)}% (Base 18% + Penalización ${(metrics.penalty * 100).toFixed(0)}%)`);
    console.log(`   - Tasa aplicada mensual:       ${(monthlyRate * 100).toFixed(2)}%`);
    
    console.log(`\n📉 IMPACTO EN TU CUENTA DE RESULTADOS`);
    console.log(`   🔥 Coste por unidad al mes:    €${costPerUnitMonth.toFixed(4)} / par`);
    console.log(`   💸 Coste total al mes:         €${totalMonthlyCost.toFixed(2)} / mes`);
    console.log(`   📅 Quemado diario (Burn Rate): €${dailyCost.toFixed(2)} / día`);

    console.log(`\n⚠️  CONCLUSIÓN:`);
    const margin = product.list_price - product.standard_price;
    const monthsToLoseMargin = margin / costPerUnitMonth;
    
    console.log(`   Tienes un margen bruto de €${margin.toFixed(2)} por unidad.`);
    console.log(`   Cada mes pierdes €${costPerUnitMonth.toFixed(2)} de ese margen en almacenamiento.`);
    if (monthsToLoseMargin < 12) {
        console.log(`   🔴 ALERTA: Si no vendes este stock en ${monthsToLoseMargin.toFixed(1)} meses, el coste de almacenamiento se habrá comido TODO tu beneficio.`);
    } else {
        console.log(`   🟢 SALUD: Tienes margen para aguantar este stock ${monthsToLoseMargin.toFixed(1)} meses antes de perder dinero.`);
    }
    console.log(`───────────────────────────────────────────────────\n`);
}

analyzeProduct().catch(console.error);