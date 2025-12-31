/**
 * Validación estricta de variables de entorno
 * Este módulo valida que todas las variables críticas estén configuradas
 */

import 'dotenv/config';

const REQUIRED_ENV_VARS = {
  ODOO_URL: 'URL de la instancia de Odoo',
  ODOO_DB: 'Nombre de la base de datos de Odoo',
  ODOO_USERNAME: 'Usuario de Odoo',
  ODOO_PASSWORD: 'Password de Odoo',
};

const OPTIONAL_ENV_VARS = {
  OPENAI_API_KEY: 'API Key de OpenAI (opcional, solo para funciones IA)',
  ANTHROPIC_API_KEY: 'API Key de Anthropic (deprecated, usar OPENAI_API_KEY)',
  PORT: 'Puerto del servidor (default: 4000)',
  SERVER_HOST: 'Host del servidor (default: localhost)',
  NODE_ENV: 'Entorno de ejecución (development/production)',
};

/**
 * Valida que todas las variables requeridas estén configuradas
 * @throws {Error} Si falta alguna variable requerida
 */
export function validateEnv() {
  const missing = [];
  const warnings = [];

  // Validar variables requeridas
  for (const [varName, description] of Object.entries(REQUIRED_ENV_VARS)) {
    if (!process.env[varName]) {
      missing.push({ varName, description });
    }
  }

  // Advertir sobre variables opcionales importantes
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    warnings.push('OPENAI_API_KEY no configurada. Funciones de IA no estarán disponibles.');
  }

  if (missing.length > 0) {
    console.error('\n❌ ERROR: Variables de entorno requeridas faltantes:\n');
    missing.forEach(({ varName, description }) => {
      console.error(`   - ${varName}: ${description}`);
    });
    console.error('\nPor favor, configura estas variables en tu archivo .env\n');
    throw new Error(`Faltan ${missing.length} variables de entorno requeridas`);
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️  ADVERTENCIAS:\n');
    warnings.forEach(warning => console.warn(`   - ${warning}`));
    console.warn('');
  }

  // Validar formato de URLs
  if (process.env.ODOO_URL && !process.env.ODOO_URL.startsWith('http')) {
    throw new Error('ODOO_URL debe ser una URL válida (http:// o https://)');
  }

  console.log('✅ Validación de variables de entorno: OK\n');
}

/**
 * Obtiene una variable de entorno con valor por defecto
 * @param {string} varName - Nombre de la variable
 * @param {any} defaultValue - Valor por defecto
 * @returns {string} Valor de la variable o default
 */
export function getEnv(varName, defaultValue = null) {
  return process.env[varName] || defaultValue;
}

/**
 * Obtiene configuración completa validada
 */
export function getConfig() {
  return {
    server: {
      port: parseInt(getEnv('PORT', '4000'), 10),
      host: getEnv('SERVER_HOST', 'localhost'),
      nodeEnv: getEnv('NODE_ENV', 'development'),
    },
    odoo: {
      url: process.env.ODOO_URL,
      db: process.env.ODOO_DB,
      username: process.env.ODOO_USERNAME,
      password: process.env.ODOO_PASSWORD,
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || null,
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || null, // Deprecated, mantener por compatibilidad
    },
  };
}



