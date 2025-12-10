// src/erp/erpCliente.js

const fs = require("fs");
const path = require("path");

// Simula la lectura desde el ERP usando tu archivo data/locations.json
async function fetchStockFromERP() {
  const filePath = path.join(__dirname, "..", "..", "data", "locations.json");

  const raw = await fs.promises.readFile(filePath, "utf8");
  const data = JSON.parse(raw);

  // data puede ser ya un array de ubicaciones;
  // si es un objeto con { locations: [...] }, ajustamos:
  return Array.isArray(data) ? data : data.locations || [];
}

module.exports = {
  fetchStockFromERP,
};
