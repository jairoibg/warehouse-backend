/**
 * Configuración centralizada de Odoo
 * Para uso en scripts de diagnóstico y herramientas
 */

import 'dotenv/config';

export function getOdooConfig() {
  const config = {
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB || 'blackdivision',
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  };

  // Validar que todas las variables estén configuradas
  const missing = [];
  if (!config.url) missing.push('ODOO_URL');
  if (!config.db) missing.push('ODOO_DB');
  if (!config.username) missing.push('ODOO_USERNAME');
  if (!config.password) missing.push('ODOO_PASSWORD');

  if (missing.length > 0) {
    throw new Error(
      `Variables de entorno faltantes para Odoo: ${missing.join(', ')}\n` +
      'Por favor, configura estas variables en tu archivo .env'
    );
  }

  return config;
}



