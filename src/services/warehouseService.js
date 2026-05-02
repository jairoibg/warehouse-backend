/**
 * Servicio de lógica de negocio del almacén
 * Motor de ingeniería: filtrado, cálculo y agregación
 */

import fs from 'fs/promises';
import { generateCSV } from '../utils/csvGenerator.js';
import { LOCATIONS_FILE } from '../config/dataPaths.js';

/**
 * Carga el contexto completo del almacén
 */
export async function getWarehouseContext() {
  try {
    const locRaw = await fs.readFile(LOCATIONS_FILE, 'utf8');
    const locations = JSON.parse(locRaw);
    
    // CÁLCULO FINANCIERO AGREGADO
    let totalValue = 0;
    let itemsWithCost = 0;
    let totalItems = 0;
    
    locations.forEach(loc => {
      if (loc.packages) {
        loc.packages.forEach(pkg => {
          const cost = pkg.cost || 0; 
          const qty = pkg.qty || 0;
          const val = qty * cost;
          totalValue += val;
          totalItems += 1;
          if (val > 0) itemsWithCost++;
        });
      }
    });

    return { locations, totalValue, itemsWithCost, totalItems };
  } catch (e) {
    console.error("Error cargando contexto:", e);
    return { locations: [], totalValue: 0, itemsWithCost: 0, totalItems: 0 };
  }
}

/**
 * Motor de ingeniería: filtrado y cálculo avanzado
 */
export async function queryWarehouseData(locations, filters) {
  console.log(" ⚙️  [MOTOR] Procesando Filtros Avanzados:", filters);

  // A. FILTRADO DE UBICACIONES (Nivel Macro)
  let results = locations.filter(loc => {
    // Filtro de Estado (Vacio/Lleno)
    if (filters.status === "EMPTY" && (loc.totalStock || 0) > 0) return false;
    if (filters.status === "OCCUPIED" && (loc.totalStock || 0) === 0) return false;
    
    // Filtro de Marca
    if (filters.brand && filters.brand !== "ALL") { 
      if (!loc.id.includes(filters.brand)) return false; 
    }
    
    // Filtro de Antigüedad (Zombis)
    if (filters.min_days_old) { 
      if (!loc.packages || !loc.packages.some(p => p.daysOld >= filters.min_days_old)) return false; 
    }
    
    // Filtro ABC (Ubicación contiene clase)
    if (filters.abc_class) { 
      if (!loc.packages || !loc.packages.some(p => p.abcClass === filters.abc_class)) return false; 
    }
    
    // Filtro TEMPORADA
    if (filters.season) {
      if (!loc.packages || !loc.packages.some(p => p.season === filters.season)) return false;
    }

    // Búsqueda de Texto Libre
    if (filters.search_text) {
      const q = filters.search_text.toLowerCase();
      const contentStr = JSON.stringify(loc.packages).toLowerCase();
      if (!contentStr.includes(q) && !loc.id.toLowerCase().includes(q)) return false;
    }
    
    // Filtro de Velocidad / Slotting
    if (filters.min_velocity) {
      if ((loc.velocityScore || 0) < filters.min_velocity) return false;
    }
    
    // Filtro de Ocupación Porcentual
    if (filters.min_occupancy_percent !== undefined || filters.max_occupancy_percent !== undefined) {
      const occupancy = Number(loc.occupancyPercentage) || 0;
      if (filters.min_occupancy_percent !== undefined && occupancy < filters.min_occupancy_percent) return false;
      if (filters.max_occupancy_percent !== undefined && occupancy > filters.max_occupancy_percent) return false;
    }

    return true;
  });

  // B. AUDITORÍA DE MEZCLAS (Ingeniería)
  if (filters.check_mixing_a_d) {
    results = results.filter(loc => {
      if (!loc.packages) return false;
      const classes = loc.packages.map(p => p.abcClass || "D");
      return classes.includes("A") && (classes.includes("D") || classes.includes("C"));
    });
  }

  // C. AGREGACIÓN MATEMÁTICA POR PRODUCTO (Nivel Micro)
  const productAggregator = {};
  let totalValueSelection = 0;

  results.forEach(loc => {
    if (!loc.packages) return;
    
    let matchQtyLoc = 0;
    
    loc.packages.forEach(pkg => {
      // Filtros finos a nivel de paquete
      if (filters.abc_class && pkg.abcClass !== filters.abc_class) return;
      if (filters.season && pkg.season !== filters.season) return;
      
      if (filters.search_text) {
        const str = (pkg.surtido || "" + pkg.productCode).toLowerCase();
        if (!str.includes(filters.search_text.toLowerCase())) return;
      }

      // Extracción de datos
      const ref = pkg.surtido || pkg.productCode || "SIN_REF";
      const qty = pkg.qty || 0;
      const cost = pkg.cost || 0;
      const vel = pkg.velocity || 0;
      const seas = pkg.season || "N/A";

      // Agregación al mapa global
      if (!productAggregator[ref]) {
        productAggregator[ref] = { 
          ref, 
          total_qty: 0, 
          total_val: 0, 
          velocity: vel,
          season: seas,
          abc: pkg.abcClass
        };
      }
      
      // Sumatorios
      productAggregator[ref].total_qty += qty;
      
      if (!filters.hide_prices) {
        productAggregator[ref].total_val += (qty * cost);
        totalValueSelection += (qty * cost);
      }
      
      matchQtyLoc += qty;
    });
    
    loc.matchQty = matchQtyLoc;
  });

  // D. CONSTRUCCIÓN DEL INFORME DE PRODUCTOS
  const topProductsList = Object.values(productAggregator).map(p => {
    let coverage = "Infinito";
    if (p.velocity > 0) coverage = Math.round(p.total_qty / p.velocity) + " días";
    else if (p.total_qty > 0) coverage = "Sin ventas (Riesgo)";
    
    if (filters.hide_prices) delete p.total_val;
    
    return { ...p, coverage };
  });

  topProductsList.sort((a, b) => b.total_qty - a.total_qty);
  results.sort((a, b) => b.matchQty - a.matchQty);

  // E. PREPARAR RESPUESTA FINAL
  const totalCount = results.length;
  const totalStockFiltered = topProductsList.reduce((acc, p) => acc + p.total_qty, 0);
  const foundIds = results.map(r => r.id);

  const response = {
    summary: {
      found: true,
      count_locations: totalCount,
      total_stock_units: totalStockFiltered,
      note: "Cálculos matemáticos verificados."
    },
    top_products_summary: topProductsList.slice(0, 10),
    found_ids: foundIds
  };

  if (!filters.hide_prices) {
    response.summary.total_value_eur = totalValueSelection.toFixed(2);
  } else {
    response.summary.privacy_mode = "ACTIVADO";
  }

  // F. EXPORTACIÓN INTELIGENTE
  if (filters.export_csv === true || (filters.auto_export_if_large && totalCount > 50)) {
    const SERVER_HOST = process.env.SERVER_HOST || "localhost";
    const PORT = process.env.PORT || 4000;
    const EXPORT_DIR = path.join(__dirname, '../../exports');
    
    console.log(` 📂  Generando Excel Masivo (${totalCount} filas)...`);
    const filename = `report_ingenieria_${Date.now()}.csv`;
    const filePath = path.join(EXPORT_DIR, filename);
    
    await fs.mkdir(EXPORT_DIR, { recursive: true });
    await fs.writeFile(filePath, generateCSV(results, filters.search_text, filters.hide_prices), 'utf8');
    
    response.summary.action = "FILE_GENERATED";
    response.summary.download_link = `http://${SERVER_HOST}:${PORT}/downloads/${filename}`;
    response.summary.message = "Datos masivos procesados. Envío resumen Top 10 y enlace de descarga.";
  }

  return JSON.stringify(response);
}

/**
 * Búsqueda detallada de datos para visualización
 */
export async function queryDetailedData(params) {
  const { locations } = await getWarehouseContext();
  const { target, type } = params;
  
  console.log(` 🧠 [CFO AI] Buscando referencia: "${target}" (${type})`);

  let data = [];
  const searchTerm = target.trim().toUpperCase().replace(/\s+/g, '');

  if (type === 'LOCATION') {
    const loc = locations.find(l => l.id === target);
    if (loc) data.push(loc);
  } else {
    locations.forEach(loc => {
      if (!loc.packages) return;
      
      const matches = loc.packages.filter(p => {
        const pCode = (p.productCode || "").toUpperCase().replace(/\s+/g, '');
        const pSurtido = (p.surtido || "").toUpperCase().replace(/\s+/g, '');
        const pPkg = (p.packageId || "").toUpperCase().replace(/\s+/g, '');
        
        return pCode.includes(searchTerm) || pSurtido.includes(searchTerm) || pPkg.includes(searchTerm);
      });
      
      if (matches.length > 0) {
        data.push({
          locationId: loc.id,
          brand: loc.brand,
          matches: matches
        });
      }
    });
  }
  
  if (data.length === 0) {
    return JSON.stringify({ 
      found: false, 
      message: `No se encontró stock con la referencia '${target}' en el Gemelo Digital.` 
    });
  }
  
  return JSON.stringify(data.slice(0, 50));
}



