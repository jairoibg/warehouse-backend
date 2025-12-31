/**
 * SERVIDOR PRINCIPAL - VERSIÓN REFACTORIZADA
 * Estructura modular y limpia
 */

import 'dotenv/config';
import express from "express";
import cors from "cors";
import compression from "compression";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { validateEnv, getConfig } from "./src/config/env.js";
import { errorHandler, asyncHandler } from "./src/middleware/errorHandler.js";
import { logger } from "./src/middleware/logger.js";
import fs from "fs/promises";

// Importar rutas modulares
import locationsRoutes from "./src/routes/locations.routes.js";
import { getLocationMovements } from "./src/routes/locations.routes.js";
import aiRoutes from "./src/routes/ai.routes.js";
import analyticsRoutes from "./src/routes/analytics.routes.js";
import dashboardRoutes from "./src/routes/dashboard.routes.js";
import devolucionesRoutes from "./src/routes/devoluciones.routes.js";
import explainRoutes from "./src/routes/explain.routes.js";
import packingRoutes from "./src/routes/packing.routes.js";
import reportsRoutes from "./src/routes/reports.routes.js";
import historyRoutes from "./src/routes/history.routes.js";
import advancedRoutes from "./src/routes/advanced.routes.js";
import notificationsRoutes from "./src/routes/notifications.routes.js";
import workflowsRoutes from "./src/routes/workflows.routes.js";
import rolesRoutes from "./src/routes/roles.routes.js";
import integrationsRoutes from "./src/routes/integrations.routes.js";
import mlRoutes from "./src/routes/ml.routes.js";

// Importar servicios
import { syncWithOdoo } from "./sync_odoo.js";
import { startHistoryCollection } from "./src/services/historyService.js";
import { startNotificationScheduler } from "./src/services/notificationService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================================================================================
//  VALIDACIÓN Y CONFIGURACIÓN
// ==================================================================================
try {
  validateEnv();
} catch (error) {
  logger.error('Error en validación de entorno', { error: error.message });
  process.exit(1);
}

const config = getConfig();
const PORT = config.server.port;
const SERVER_HOST = config.server.host;

// ==================================================================================
//  CONFIGURACIÓN DEL SERVIDOR EXPRESS
// ==================================================================================
const app = express();

// Compresión gzip para reducir el tamaño de las respuestas (mejora velocidad de carga)
app.use(compression());

app.use(cors());
app.use(express.json());

// Directorio de exports
const EXPORT_DIR = path.join(__dirname, "exports");
import fsSync from "fs";
if (!fsSync.existsSync(EXPORT_DIR)) {
  fsSync.mkdirSync(EXPORT_DIR, { recursive: true });
}
app.use("/downloads", express.static(EXPORT_DIR));

// ==================================================================================
//  RUTA DE SALUD (health check)
// ==================================================================================
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ==================================================================================
//  RUTAS MODULARES
// ==================================================================================
app.use("/api/locations", locationsRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/devoluciones", devolucionesRoutes);
app.use("/api/explain", explainRoutes);
app.use("/api/packing", packingRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/history", historyRoutes);
app.use("/api/advanced", advancedRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/workflows", workflowsRoutes);
app.use("/api/roles", rolesRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/ml", mlRoutes);

// ==================================================================================
//  RUTAS DE COMPATIBILIDAD (mantener endpoints antiguos para el frontend)
// ==================================================================================
// Compatibilidad: /api/strategic-analysis -> /api/ai/strategic-analysis
app.post("/api/strategic-analysis", asyncHandler(async (req, res) => {
  req.url = '/strategic-analysis';
  req.baseUrl = '/api/ai';
  return aiRoutes.handle(req, res);
}));

// Compatibilidad: /api/strategic-chat -> /api/ai/strategic-chat
app.post("/api/strategic-chat", asyncHandler(async (req, res) => {
  req.url = '/strategic-chat';
  req.baseUrl = '/api/ai';
  return aiRoutes.handle(req, res);
}));

// Compatibilidad: /api/movements -> /api/locations/movements
app.get("/api/movements", asyncHandler(async (req, res) => {
  req.url = '/movements';
  req.baseUrl = '/api/locations';
  return locationsRoutes.handle(req, res);
}));

// Compatibilidad: /api/movements/:locationId -> /api/locations/movements/:locationId
app.get("/api/movements/:locationId", asyncHandler(getLocationMovements));

// ==================================================================================
//  WEBSOCKET PARA ACTUALIZACIONES EN TIEMPO REAL
// ==================================================================================
const server = createServer(app);
const wss = new WebSocketServer({ server });

function broadcastUpdate(data) {
  wss.clients.forEach(c => { 
    if (c.readyState === 1) {
      c.send(JSON.stringify({ type: "UPDATE_LOCATIONS", payload: data }));
    }
  });
}

wss.on("connection", () => {
  logger.info("WebSocket conectado");
});

// ==================================================================================
//  SINCRONIZACIÓN AUTOMÁTICA CON ODOO
// ==================================================================================
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '5000', 10);
let isSyncing = false;

setInterval(async () => {
  if (isSyncing) return;
  try {
    isSyncing = true;
    const updatedData = await syncWithOdoo();
    if (updatedData) {
      broadcastUpdate(updatedData);
      logger.debug("Sincronización completada", { locations: updatedData.length });
    }
  } catch (e) {
    logger.error("Error en sincronización", { error: e.message });
  } finally {
    isSyncing = false;
  }
}, POLLING_INTERVAL_MS);

// ==================================================================================
//  MIDDLEWARE DE ERRORES (debe ir al final)
// ==================================================================================
app.use(errorHandler);

// ==================================================================================
//  INICIO DEL SERVIDOR
// ==================================================================================
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Servidor iniciado en ${SERVER_HOST}:${PORT}`);
  logger.info(`📊 Estructura modular activa`);
  logger.info(`🔄 Sincronización cada ${POLLING_INTERVAL_MS}ms`);
  
  // Iniciar recolección de historial (cada hora)
  // Iniciar recolección de historial (cada hora)
  startHistoryCollection(60);
  // Guardar snapshot inicial
  import('./src/services/historyService.js').then(({ saveMetricsSnapshot }) => {
    saveMetricsSnapshot().catch(err => logger.warn('Error en snapshot inicial', { error: err.message }));
  });
  
  // Iniciar programador de notificaciones (cada 24 horas)
  startNotificationScheduler(24);
});

