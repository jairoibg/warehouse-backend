/**
 * Generador de CSV para reportes
 */

export function generateCSV(data, searchTerm = "", hidePrices = false) {
  // Construcción de la cabecera dinámica
  let header = "ID_UBICACION;MARCA;TEMPORADAS;STOCK_TOTAL_UBICACION";
  
  // Columna financiera condicional
  if (!hidePrices) header += ";VALOR_STOCK_€"; 
  
  header += ";CLASES_ABC;DIAS_MAX;OCUPACION_%";
  
  // Columna de precisión de búsqueda
  if (searchTerm) header += ";STOCK_EXACTO_BUSQUEDA"; 
  
  // Columnas de desglose de contenido
  header += ";PRODUCTOS_A;PRODUCTOS_B;PRODUCTOS_C;PRODUCTOS_D\n";

  const rows = data.map(loc => {
    // Datos calculados de la ubicación
    const classes = [...new Set(loc.packages.map(p => p.abcClass))].join("+");
    const seasons = [...new Set(loc.packages.map(p => p.season || "N/A"))].join("+");
    const maxDays = Math.max(...loc.packages.map(p => p.daysOld || 0));
    const vol = Math.round(loc.occupancyPercentage || 0);
    
    // Cálculo de valor (solo si no es privado)
    const locValue = !hidePrices 
      ? loc.packages.reduce((sum, p) => sum + ((p.qty || 0) * (p.cost || 0)), 0).toFixed(2) 
      : "";

    // Formateador de paquetes para las celdas de detalle
    const formatPack = (p) => `[${p.productCode}] ${p.qty}u (${p.season}) ${p.daysOld}d`;

    // Segregación por columnas ABC
    const prodA = loc.packages.filter(p => p.abcClass === 'A').map(formatPack).join(" | ");
    const prodB = loc.packages.filter(p => p.abcClass === 'B').map(formatPack).join(" | ");
    const prodC = loc.packages.filter(p => p.abcClass === 'C').map(formatPack).join(" | ");
    const prodD = loc.packages.filter(p => p.abcClass === 'D' || !p.abcClass).map(formatPack).join(" | ");
    
    // Construcción de la fila CSV
    let row = `${loc.id};${loc.brand};${seasons};${loc.totalStock}`;
    
    if (!hidePrices) row += `;${locValue}`;
    
    row += `;${classes};${maxDays};${vol}`;
    
    if (searchTerm) row += `;${loc.matchQty || 0}`;
    
    row += `;${prodA};${prodB};${prodC};${prodD}`;
    return row;
  }).join("\n");

  return header + rows;
}



