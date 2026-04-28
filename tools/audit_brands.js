import 'dotenv/config';
import xmlrpc from 'xmlrpc';

// --- CREDENCIALES ---
const ODOO_CONFIG = {
  url: process.env.ODOO_URL,
  db: process.env.ODOO_DB,
  username: process.env.ODOO_USERNAME,
  password: process.env.ODOO_PASSWORD,
};

// --- REGLAS DE NEGOCIO ACTUALIZADAS (Gold incluye Submarcas) ---
function detectBrand(productCode, productName) {
    const code = (productCode || "").toUpperCase();
    const name = (productName || "").toUpperCase();
    
    // 1. BLACK (D.Franklin)
    if (code.startsWith("DF") || code.startsWith("IBGB") || name.includes("D.FRANKLIN")) return "BLACK";
    
    // 2. WHITE (Kalk)
    if (code.startsWith("KA") || code.startsWith("KL") || code.startsWith("IBGW") || name.includes("KALK")) return "WHITE";
    
    // 3. GOLD (Conguitos + Break&Walk + Osito + Tecnobaby)
    if (
        code.startsWith("CO") || code.startsWith("IBGG") || name.includes("CONGUITOS") ||
        code.startsWith("BW") || // Break&Walk
        code.startsWith("BJ") || // Break&Walk (Junior/Alternative)
        code.startsWith("OS") || // Osito
        code.startsWith("TE") || // Tecnobaby
        name.includes("BREAK") || name.includes("WALK") || name.includes("OSITO") || name.includes("TECNO")
    ) return "GOLD";
    
    // 4. Otros
    return "GENERIC"; 
}

async function startAudit() {
  console.log(" 👮  AUDITORÍA DE INTEGRIDAD V3 (Jerarquía Gold Corregida)");
  console.log(" -------------------------------------------------------");

  const common = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${ODOO_CONFIG.url}/xmlrpc/2/object` });

  try {
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        ODOO_CONFIG.db, ODOO_CONFIG.username, ODOO_CONFIG.password, {}
      ], (err, res) => err ? reject(err) : resolve(res));
    });

    if (!uid) { console.error("❌ Error Auth."); return; }
    console.log(" ✅  Conectado. Bajando stock...");

    const quants = await new Promise((resolve, reject) => {
        models.methodCall('execute_kw', [
            ODOO_CONFIG.db, uid, ODOO_CONFIG.password,
            'stock.quant', 'search_read', 
            [[['location_id.usage', '=', 'internal']]], 
            { fields: ['location_id', 'product_id', 'quantity'] }
        ], (err, res) => err ? reject(err) : resolve(res));
    });

    console.log(` 📦  Analizando ${quants.length} líneas...`);

    const locationAnalysis = {};

    quants.forEach(q => {
        const locName = q.location_id[1]; 
        // Filtramos solo estanterías para no ver basura de devoluciones
        if (!locName.includes("CLA-")) return;

        const prodCode = q.product_id[1].split("]")[0].replace("[", "");
        const prodName = q.product_id[1];
        const qty = q.quantity;

        if (qty <= 0) return; 

        const brand = detectBrand(prodCode, prodName);

        if (!locationAnalysis[locName]) {
            locationAnalysis[locName] = { brands: new Set(), details: [] };
        }

        locationAnalysis[locName].brands.add(brand);
        // Guardamos detalle para mostrar evidencia
        if (brand !== "GENERIC") {
            locationAnalysis[locName].details.push(`[${brand}] ${prodName}`);
        }
    });

    console.log("\n 🚨  CONFLICTOS REALES (Marcas Cruzadas):");
    console.log(" =============================================");

    let dirtyCount = 0;

    for (const [locName, data] of Object.entries(locationAnalysis)) {
        // Ignoramos GENERIC, ahora que Gold está bien definido, Generic debería ser casi 0
        const mainBrands = Array.from(data.brands).filter(b => b !== "GENERIC");
        
        // ERROR si hay más de 1 marca principal distinta (Ej: BLACK + GOLD)
        if (mainBrands.length > 1) {
            dirtyCount++;
            console.log(`\n ❌  ${locName}`);
            console.log(`     Mezcla Prohibida: ${mainBrands.join(" + ")}`);
            // Mostramos solo los primeros 3 productos para no saturar
            data.details.slice(0, 3).forEach(d => console.log(`       -> ${d}`));
        }
    }

    console.log("\n =============================================");
    console.log(` 🏁  UBICACIONES A LIMPIAR: ${dirtyCount}`);
    
    if (dirtyCount === 0) console.log(" ✅  ¡Perfecto! No hay mezclas entre Black, White y Gold.");

  } catch (error) {
    console.error("Error:", error);
  }
}

startAudit();