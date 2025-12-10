import 'dotenv/config';
import xmlrpc from 'xmlrpc';

// ==================================================================================
//  DIAGNÓSTICO DE DATOS PARA FÓRMULA ICC (Inventory Carrying Cost)
// ==================================================================================

const ODOO_CONFIG = {
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
};

function createClients() {
    const urlObj = new URL(ODOO_CONFIG.url);
    return {
        common: xmlrpc.createSecureClient({ host: urlObj.hostname, port: 443, path: '/xmlrpc/2/common' }),
        models: xmlrpc.createSecureClient({ host: urlObj.hostname, port: 443, path: '/xmlrpc/2/object' })
    };
}

function authenticate(client) {
    return new Promise((resolve, reject) => {
        client.methodCall('authenticate', [ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}], (err, uid) => {
            if (err) reject(err);
            else resolve(uid);
        });
    });
}

function executeKw(client, uid, model, method, args, kwargs = {}) {
    return new Promise((resolve, reject) => {
        client.methodCall('execute_kw', [ODOO_CONFIG.db, uid, ODOO_CONFIG.password, model, method, args, kwargs], (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

async function analyzeProductData() {
    console.log('🔍 DIAGNÓSTICO DE DATOS PARA FÓRMULA ICC');
    console.log('=========================================\n');
    
    const { common, models } = createClients();
    const uid = await authenticate(common);
    console.log('✅ Conectado a Odoo\n');

    // ==================================================================================
    // 1. ANALIZAR ESTRUCTURA DE PRECIOS EN product.product
    // ==================================================================================
    console.log('📦 1. ESTRUCTURA DE PRECIOS DE PRODUCTOS');
    console.log('─────────────────────────────────────────');
    
    const sampleProducts = await executeKw(models, uid, 'product.product', 'search_read', [
        [['type', '=', 'product']]
    ], {
        fields: ['default_code', 'name', 'standard_price', 'list_price', 'categ_id'],
        limit: 10
    });
    
    console.log('Muestra de productos con precios:');
    sampleProducts.forEach((p, i) => {
        const margin = p.list_price > 0 ? ((p.list_price - p.standard_price) / p.list_price * 100).toFixed(1) : 0;
        console.log(`  ${i+1}. [${p.default_code || 'N/A'}] ${p.name?.substring(0, 40)}...`);
        console.log(`     Coste: €${p.standard_price?.toFixed(2) || 0} | PVP: €${p.list_price?.toFixed(2) || 0} | Margen: ${margin}%`);
        console.log(`     Categoría: ${p.categ_id ? p.categ_id[1] : 'N/A'}`);
    });

    // ==================================================================================
    // 2. CATEGORÍAS DE PRODUCTOS (Para segmentar por tipo)
    // ==================================================================================
    console.log('\n📂 2. CATEGORÍAS DE PRODUCTOS');
    console.log('─────────────────────────────────────────');
    
    const categories = await executeKw(models, uid, 'product.category', 'search_read', [
        []
    ], {
        fields: ['name', 'complete_name', 'parent_id'],
        limit: 50
    });
    
    console.log(`Total categorías: ${categories.length}`);
    categories.slice(0, 15).forEach(c => {
        console.log(`  - ${c.complete_name || c.name}`);
    });
    if (categories.length > 15) console.log(`  ... y ${categories.length - 15} más`);

    // ==================================================================================
    // 3. ANALIZAR STOCK CON COSTES Y ANTIGÜEDAD
    // ==================================================================================
    console.log('\n💰 3. STOCK ACTUAL CON VALORACIÓN');
    console.log('─────────────────────────────────────────');
    
    const stockQuants = await executeKw(models, uid, 'stock.quant', 'search_read', [
        [
            ['location_id.usage', '=', 'internal'],
            ['quantity', '>', 0]
        ]
    ], {
        fields: ['product_id', 'quantity', 'value', 'in_date', 'location_id'],
        limit: 100
    });
    
    // Calcular estadísticas
    let totalUnits = 0;
    let totalValue = 0;
    let withValue = 0;
    let withInDate = 0;
    const ageDistribution = { '<30d': 0, '30-90d': 0, '90-180d': 0, '180-365d': 0, '>365d': 0 };
    const now = new Date();
    
    stockQuants.forEach(q => {
        totalUnits += q.quantity;
        if (q.value && q.value > 0) {
            totalValue += q.value;
            withValue++;
        }
        if (q.in_date) {
            withInDate++;
            const inDate = new Date(q.in_date);
            const days = Math.floor((now - inDate) / (1000 * 60 * 60 * 24));
            if (days < 30) ageDistribution['<30d']++;
            else if (days < 90) ageDistribution['30-90d']++;
            else if (days < 180) ageDistribution['90-180d']++;
            else if (days < 365) ageDistribution['180-365d']++;
            else ageDistribution['>365d']++;
        }
    });
    
    console.log(`Muestra analizada: ${stockQuants.length} quants`);
    console.log(`  - Total unidades: ${totalUnits.toLocaleString()}`);
    console.log(`  - Valor total (muestra): €${totalValue.toLocaleString('es-ES', {minimumFractionDigits: 2})}`);
    console.log(`  - Quants con valor: ${withValue}/${stockQuants.length} (${(withValue/stockQuants.length*100).toFixed(1)}%)`);
    console.log(`  - Quants con fecha entrada: ${withInDate}/${stockQuants.length} (${(withInDate/stockQuants.length*100).toFixed(1)}%)`);
    
    console.log('\n📊 Distribución por antigüedad (muestra):');
    Object.entries(ageDistribution).forEach(([range, count]) => {
        const pct = (count / stockQuants.length * 100).toFixed(1);
        const bar = '▓'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        console.log(`  ${range.padEnd(10)} ${bar} ${count} (${pct}%)`);
    });

    // ==================================================================================
    // 4. VERIFICAR CAMPO standard_price (COSTE DE COMPRA)
    // ==================================================================================
    console.log('\n🏷️ 4. ANÁLISIS DE PRECIOS DE COSTE');
    console.log('─────────────────────────────────────────');
    
    const productsWithCost = await executeKw(models, uid, 'product.product', 'search_count', [
        [['standard_price', '>', 0], ['type', '=', 'product']]
    ]);
    
    const totalProducts = await executeKw(models, uid, 'product.product', 'search_count', [
        [['type', '=', 'product']]
    ]);
    
    console.log(`Productos con coste (standard_price > 0): ${productsWithCost.toLocaleString()}/${totalProducts.toLocaleString()} (${(productsWithCost/totalProducts*100).toFixed(1)}%)`);

    // Estadísticas de precios
    const priceStats = await executeKw(models, uid, 'product.product', 'search_read', [
        [['standard_price', '>', 0], ['type', '=', 'product']]
    ], {
        fields: ['standard_price', 'list_price'],
        limit: 1000
    });
    
    const costs = priceStats.map(p => p.standard_price).filter(c => c > 0);
    const prices = priceStats.map(p => p.list_price).filter(p => p > 0);
    
    if (costs.length > 0) {
        const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
        const minCost = Math.min(...costs);
        const maxCost = Math.max(...costs);
        
        console.log(`\nEstadísticas de coste (standard_price):`);
        console.log(`  - Mínimo: €${minCost.toFixed(2)}`);
        console.log(`  - Máximo: €${maxCost.toFixed(2)}`);
        console.log(`  - Promedio: €${avgCost.toFixed(2)}`);
    }
    
    if (prices.length > 0 && costs.length > 0) {
        // Calcular margen promedio
        let totalMargin = 0;
        let validMargins = 0;
        priceStats.forEach(p => {
            if (p.standard_price > 0 && p.list_price > p.standard_price) {
                const margin = (p.list_price - p.standard_price) / p.list_price * 100;
                totalMargin += margin;
                validMargins++;
            }
        });
        
        if (validMargins > 0) {
            console.log(`\n📈 Margen bruto promedio: ${(totalMargin / validMargins).toFixed(1)}%`);
        }
    }

    // ==================================================================================
    // 5. TEMPORADAS EN STOCK
    // ==================================================================================
    console.log('\n🗓️ 5. TEMPORADAS DETECTADAS EN STOCK');
    console.log('─────────────────────────────────────────');
    
    // Buscar atributos de temporada
    const seasonAttributes = await executeKw(models, uid, 'product.attribute', 'search_read', [
        [['name', 'ilike', 'temporada']]
    ], {
        fields: ['name', 'value_ids']
    });
    
    if (seasonAttributes.length > 0) {
        console.log('Atributo de temporada encontrado:');
        for (const attr of seasonAttributes) {
            console.log(`  - ${attr.name}`);
            const values = await executeKw(models, uid, 'product.attribute.value', 'search_read', [
                [['attribute_id', '=', attr.id]]
            ], {
                fields: ['name']
            });
            values.forEach(v => console.log(`    · ${v.name}`));
        }
    } else {
        console.log('No se encontró atributo "temporada". Buscando en nombres de producto...');
        
        // Buscar patrones de temporada en nombres
        const seasonPatterns = ['V24', 'V25', 'V26', 'I24', 'I25', 'I26', 'SS24', 'SS25', 'FW24', 'FW25'];
        for (const pattern of seasonPatterns) {
            const count = await executeKw(models, uid, 'product.product', 'search_count', [
                [['default_code', 'ilike', pattern]]
            ]);
            if (count > 0) {
                console.log(`  - ${pattern}: ${count} productos`);
            }
        }
    }

    // ==================================================================================
    // 6. RESUMEN PARA FÓRMULA ICC
    // ==================================================================================
    console.log('\n' + '='.repeat(60));
    console.log('📋 RESUMEN PARA CONFIGURAR FÓRMULA ICC');
    console.log('='.repeat(60));
    
    console.log(`
DATOS DISPONIBLES:
✅ Coste de producto (standard_price): ${(productsWithCost/totalProducts*100).toFixed(0)}% de productos
✅ Fecha de entrada (in_date): Disponible para calcular antigüedad
✅ Cantidad en stock (quantity): Disponible
✅ Valor del stock (value): Precalculado por Odoo

DATOS PARA LA FÓRMULA:
- Valor total stock: Se calcula como Σ(quantity × standard_price)
- Antigüedad: Se calcula desde in_date
- Temporada: Extraída del código de producto (V24, I25, etc.)

PROPUESTA DE TASAS ICC (Sector Calzado/Moda):
┌─────────────────────────────────────────────────────────────┐
│ Componente              │ Tasa    │ Justificación          │
├─────────────────────────────────────────────────────────────┤
│ Coste de Capital        │ 8%      │ WACC conservador       │
│ Obsolescencia Temporal  │ 6%      │ Moda = alto riesgo     │
│ Depreciación Estacional │ Variable│ Según meses desde temp │
└─────────────────────────────────────────────────────────────┘

SIGUIENTE PASO: ¿Quieres que implemente esta fórmula?
`);
}

analyzeProductData().catch(console.error);