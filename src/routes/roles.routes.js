/**
 * Rutas para gestión de roles y dashboards personalizables
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  getDashboardConfig,
  hasPermission,
  getRoleInfo,
  getAllRoles,
  customizeDashboard
} from '../services/roleService.js';

const router = express.Router();

/**
 * GET /api/roles
 * Obtiene todos los roles disponibles
 */
router.get('/', asyncHandler(async (req, res) => {
  const roles = getAllRoles();
  res.json({
    success: true,
    roles
  });
}));

/**
 * GET /api/roles/:role
 * Obtiene información de un rol específico
 */
router.get('/:role', asyncHandler(async (req, res) => {
  const { role } = req.params;
  const roleInfo = getRoleInfo(role);
  
  if (!roleInfo) {
    return res.status(404).json({
      success: false,
      error: 'Rol no encontrado'
    });
  }
  
  res.json({
    success: true,
    role: roleInfo
  });
}));

/**
 * GET /api/roles/:role/dashboard
 * Obtiene configuración de dashboard para un rol
 */
router.get('/:role/dashboard', asyncHandler(async (req, res) => {
  const { role } = req.params;
  const config = getDashboardConfig(role);
  
  res.json({
    success: true,
    role,
    dashboard: config
  });
}));

/**
 * POST /api/roles/:role/dashboard/customize
 * Personaliza dashboard para un rol
 */
router.post('/:role/dashboard/customize', asyncHandler(async (req, res) => {
  const { role } = req.params;
  const { customizations } = req.body;
  
  const customized = customizeDashboard(role, customizations);
  
  res.json({
    success: true,
    role,
    dashboard: customized
  });
}));

/**
 * GET /api/roles/:role/permissions/:permission
 * Verifica si un rol tiene un permiso
 */
router.get('/:role/permissions/:permission', asyncHandler(async (req, res) => {
  const { role, permission } = req.params;
  const hasAccess = hasPermission(role, permission);
  
  res.json({
    success: true,
    role,
    permission,
    hasAccess
  });
}));

export default router;



