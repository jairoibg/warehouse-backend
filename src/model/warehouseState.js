// src/model/warehouseState.js

// Estado en memoria (fase 1). Luego podemos llevarlo a BBDD.
const locations = new Map(); // key: locationId, value: { ...datos ubicación... }

function upsertLocation(location) {
  if (!location.id) return;
  const current = locations.get(location.id) || {};
  const merged = { ...current, ...location };
  locations.set(location.id, merged);
  return merged;
}

function getAllLocations() {
  return Array.from(locations.values());
}

function getLocationById(id) {
  return locations.get(id) || null;
}

module.exports = {
  upsertLocation,
  getAllLocations,
  getLocationById,
};
