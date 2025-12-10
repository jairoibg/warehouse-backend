// src/erp/syncService.js

const { fetchStockFromERP } = require("./erpClient");
const { upsertLocation } = require("../model/warehouseState");

// Aquí transformas los datos del ERP al modelo del twin
async function syncFromERP() {
  const rows = await fetchStockFromERP();

  for (const row of rows) {
    // OJO: aquí tendrás que adaptar nombres a tus columnas reales
    const locationId = row.locationId; // ej: "CLA-004-01-01-01"
    const location = {
      id: locationId,
      aisle: row.aisle,
      block: row.block,
      level: row.level,
      position: row.position,
      stockTotal: row.qtyTotal,
      stockReserved: row.qtyReserved || 0,
      // puedes guardar más cosas
    };

    upsertLocation(location);
  }
}

module.exports = {
  syncFromERP,
};
