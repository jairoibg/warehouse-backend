/**
 * Servicio de análisis de ventas y BI
 */

import { getRealTimeSales } from './odooService.js';

/**
 * Analiza datos de ventas de Odoo
 */
export async function analyzeSalesData(args) {
  console.log(" 💰  [BI] Analizando Ventas Odoo:", args);
  const days = args.days_back || 7;
  const rawSales = await getRealTimeSales(days);
  
  if (!rawSales || rawSales.length === 0) {
    return JSON.stringify({ message: "No se encontraron ventas en el periodo." });
  }

  const stats = { 
    total_units: 0, 
    by_brand: { BLACK: 0, GOLD: 0, WHITE: 0, GENERIC: 0 }, 
    top_products: [] 
  };
  
  if (!args.hide_prices) stats.total_value = 0;

  const productMap = {};

  rawSales.forEach(line => {
    const name = line.p || "Desconocido";
    const qty = line.q || 0;
    const val = line.v || 0;
    
    stats.total_units += qty;
    if (!args.hide_prices) stats.total_value = (stats.total_value || 0) + val;

    // Lógica de Marcas
    let brand = "GENERIC";
    const upper = name.toUpperCase();
    if (upper.includes("DF") || upper.includes("BLACK")) brand = "BLACK";
    else if (upper.includes("CO") || upper.includes("GOLD")) brand = "GOLD";
    else if (upper.includes("KA") || upper.includes("WHITE")) brand = "WHITE";

    stats.by_brand[brand] = (stats.by_brand[brand] || 0) + qty;

    if (!productMap[name]) productMap[name] = { name, qty: 0 };
    productMap[name].qty += qty;
    if (!args.hide_prices) productMap[name].val = (productMap[name].val || 0) + val;
  });

  stats.top_products = Object.values(productMap)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);
    
  return JSON.stringify({ period: `Últimos ${days} días`, summary: stats });
}



