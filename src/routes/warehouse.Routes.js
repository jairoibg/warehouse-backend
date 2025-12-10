// src/routes/warehouseRoutes.js

const express = require("express");
const { getAllLocations, getLocationById } = require("../model/warehouseState");

const router = express.Router();

// Layout estático (de momento sacado de las ubicaciones)
router.get("/layout", (req, res) => {
  const locations = getAllLocations();
  res.json({ locations });
});

// Todas las ubicaciones con stock
router.get("/locations", (req, res) => {
  const locations = getAllLocations();
  res.json(locations);
});

// Detalle de una ubicación concreta
router.get("/location/:id", (req, res) => {
  const loc = getLocationById(req.params.id);
  if (!loc) return res.status(404).json({ error: "Location not found" });

  // Aquí podrías incluir paquetes/productos si los guardas en el modelo
  res.json(loc);
});

module.exports = router;
