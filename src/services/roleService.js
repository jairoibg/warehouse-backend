/**
 * Sistema de roles y permisos para dashboard personalizable
 */

import { logger } from '../middleware/logger.js';

// Definición de roles y sus permisos
const ROLES = {
  ADMIN: {
    name: 'Administrador',
    permissions: ['*'], // Todos los permisos
    dashboard: {
      sections: ['all'],
      kpis: ['all'],
      reports: ['all'],
      analytics: ['all']
    }
  },
  
  MANAGER: {
    name: 'Gerente',
    permissions: [
      'view:all',
      'export:reports',
      'view:costs',
      'view:analytics',
      'view:recommendations'
    ],
    dashboard: {
      sections: ['overview', 'kpis', 'alerts', 'analytics', 'costs', 'recommendations'],
      kpis: ['inventoryValue', 'occupancyRate', 'criticalIssues', 'costs'],
      reports: ['executive', 'inventory', 'alerts'],
      analytics: ['all']
    }
  },
  
  ANALYST: {
    name: 'Analista',
    permissions: [
      'view:analytics',
      'view:reports',
      'export:data',
      'view:trends'
    ],
    dashboard: {
      sections: ['analytics', 'trends', 'reports'],
      kpis: ['inventoryValue', 'occupancyRate'],
      reports: ['all'],
      analytics: ['all']
    }
  },
  
  OPERATOR: {
    name: 'Operador',
    permissions: [
      'view:locations',
      'view:movements',
      'view:alerts'
    ],
    dashboard: {
      sections: ['locations', 'movements', 'alerts'],
      kpis: ['occupancyRate', 'criticalIssues'],
      reports: ['alerts'],
      analytics: []
    }
  },
  
  VIEWER: {
    name: 'Visualizador',
    permissions: [
      'view:overview',
      'view:reports'
    ],
    dashboard: {
      sections: ['overview', 'kpis'],
      kpis: ['inventoryValue', 'occupancyRate'],
      reports: ['executive'],
      analytics: []
    }
  }
};

// Configuraciones de dashboard personalizadas por rol
const DASHBOARD_CONFIGS = {
  ADMIN: {
    layout: 'grid',
    widgets: [
      { type: 'kpi', id: 'inventoryValue', position: { x: 0, y: 0, w: 2, h: 1 } },
      { type: 'kpi', id: 'occupancyRate', position: { x: 2, y: 0, w: 2, h: 1 } },
      { type: 'kpi', id: 'criticalIssues', position: { x: 4, y: 0, w: 2, h: 1 } },
      { type: 'chart', id: 'occupancyTrend', position: { x: 0, y: 1, w: 4, h: 2 } },
      { type: 'chart', id: 'abcDistribution', position: { x: 4, y: 1, w: 2, h: 2 } },
      { type: 'table', id: 'alerts', position: { x: 0, y: 3, w: 6, h: 2 } },
      { type: 'table', id: 'recommendations', position: { x: 0, y: 5, w: 6, h: 2 } }
    ],
    refreshInterval: 5000
  },
  
  MANAGER: {
    layout: 'grid',
    widgets: [
      { type: 'kpi', id: 'inventoryValue', position: { x: 0, y: 0, w: 2, h: 1 } },
      { type: 'kpi', id: 'occupancyRate', position: { x: 2, y: 0, w: 2, h: 1 } },
      { type: 'kpi', id: 'costs', position: { x: 4, y: 0, w: 2, h: 1 } },
      { type: 'chart', id: 'occupancyTrend', position: { x: 0, y: 1, w: 3, h: 2 } },
      { type: 'chart', id: 'costBreakdown', position: { x: 3, y: 1, w: 3, h: 2 } },
      { type: 'table', id: 'alerts', position: { x: 0, y: 3, w: 6, h: 2 } },
      { type: 'table', id: 'recommendations', position: { x: 0, y: 5, w: 6, h: 2 } }
    ],
    refreshInterval: 10000
  },
  
  ANALYST: {
    layout: 'grid',
    widgets: [
      { type: 'chart', id: 'trends', position: { x: 0, y: 0, w: 6, h: 3 } },
      { type: 'chart', id: 'abcDistribution', position: { x: 0, y: 3, w: 3, h: 2 } },
      { type: 'chart', id: 'seasonalPatterns', position: { x: 3, y: 3, w: 3, h: 2 } },
      { type: 'table', id: 'analytics', position: { x: 0, y: 5, w: 6, h: 2 } }
    ],
    refreshInterval: 30000
  },
  
  OPERATOR: {
    layout: 'list',
    widgets: [
      { type: 'kpi', id: 'occupancyRate', position: { x: 0, y: 0, w: 2, h: 1 } },
      { type: 'kpi', id: 'criticalIssues', position: { x: 2, y: 0, w: 2, h: 1 } },
      { type: 'table', id: 'alerts', position: { x: 0, y: 1, w: 4, h: 3 } },
      { type: 'map', id: 'locations', position: { x: 0, y: 4, w: 4, h: 3 } }
    ],
    refreshInterval: 5000
  },
  
  VIEWER: {
    layout: 'simple',
    widgets: [
      { type: 'kpi', id: 'inventoryValue', position: { x: 0, y: 0, w: 2, h: 1 } },
      { type: 'kpi', id: 'occupancyRate', position: { x: 2, y: 0, w: 2, h: 1 } },
      { type: 'chart', id: 'overview', position: { x: 0, y: 1, w: 4, h: 2 } }
    ],
    refreshInterval: 60000
  }
};

/**
 * Obtiene configuración de dashboard para un rol
 */
export function getDashboardConfig(role) {
  const roleUpper = role?.toUpperCase();
  
  if (!ROLES[roleUpper]) {
    logger.warn(`Rol ${role} no encontrado, usando VIEWER por defecto`);
    return DASHBOARD_CONFIGS.VIEWER;
  }
  
  return DASHBOARD_CONFIGS[roleUpper] || DASHBOARD_CONFIGS.VIEWER;
}

/**
 * Verifica si un rol tiene un permiso
 */
export function hasPermission(role, permission) {
  const roleUpper = role?.toUpperCase();
  const roleConfig = ROLES[roleUpper];
  
  if (!roleConfig) {
    return false;
  }
  
  // Admin tiene todos los permisos
  if (roleConfig.permissions.includes('*')) {
    return true;
  }
  
  // Verificar permiso específico
  if (roleConfig.permissions.includes(permission)) {
    return true;
  }
  
  // Verificar permiso con wildcard (ej: 'view:*' para 'view:all')
  const [action] = permission.split(':');
  if (roleConfig.permissions.includes(`${action}:*`)) {
    return true;
  }
  
  return false;
}

/**
 * Obtiene información de un rol
 */
export function getRoleInfo(role) {
  const roleUpper = role?.toUpperCase();
  return ROLES[roleUpper] || null;
}

/**
 * Obtiene todos los roles disponibles
 */
export function getAllRoles() {
  return Object.entries(ROLES).map(([key, config]) => ({
    id: key,
    name: config.name,
    permissions: config.permissions,
    dashboardSections: config.dashboard.sections
  }));
}

/**
 * Personaliza configuración de dashboard para un usuario
 */
export function customizeDashboard(role, customizations) {
  const baseConfig = getDashboardConfig(role);
  
  // Aplicar personalizaciones
  const customized = {
    ...baseConfig,
    ...customizations,
    widgets: customizations.widgets || baseConfig.widgets,
    refreshInterval: customizations.refreshInterval || baseConfig.refreshInterval
  };
  
  return customized;
}



