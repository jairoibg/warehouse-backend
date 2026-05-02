// ==================================================================================
//  src/config/dataPaths.js
//  Constantes centrales de rutas de datos.
//
//  CONTEXTO (auditoría 2026-04-28):
//  Antes había 13+ sitios que leían `locations.json` con
//  `path.join(__dirname, "data", "locations.json")` (filesystem efímero del
//  contenedor) mientras que `sync_odoo.js` ESCRIBÍA en el volumen Railway
//  (`/data/locations.json`). Resultado: el endpoint `/api/locations` y otros
//  servían un snapshot del repo del último commit, NO los datos frescos del
//  sync con Odoo. Por eso aparecían paquetes que ya no existían en Odoo
//  (eran del commit antiguo) y el operario veía datos viejos al entrar.
//
//  Este módulo unifica las rutas. Todos los archivos importan de aquí.
//
//  Compatibilidad:
//  - En Railway con volumen montado (RAILWAY_VOLUME_MOUNT_PATH definido):
//    los datos van al volumen y persisten entre deploys.
//  - En local/dev sin esa env, caen al `./data/` del repo (mismo
//    comportamiento que antes en local).
// ==================================================================================

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// __dirname = .../warehouse-backend-git/src/config
// Subir 2 niveles para llegar a la raíz del proyecto.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Carpeta del repo (versionada). Contiene los seeds y baseline.
export const LOCAL_DATA_DIR = path.join(PROJECT_ROOT, 'data');

// Carpeta donde viven los datos runtime (volumen Railway en prod, ./data en local).
export const PERSISTENT_DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : LOCAL_DATA_DIR;

// Archivo principal de ubicaciones — fuente única de verdad post-sync con Odoo.
export const LOCATIONS_FILE = path.join(PERSISTENT_DATA_DIR, 'locations.json');

// Devoluciones B2B
export const DEVOLUCIONES_FILE = path.join(PERSISTENT_DATA_DIR, 'devoluciones.json');
export const DEVOLUCIONES_SEED_FILE = path.join(LOCAL_DATA_DIR, 'devoluciones.seed.json');
export const DEVOLUCIONES_JOURNAL_FILE = path.join(PERSISTENT_DATA_DIR, 'devoluciones_journal.jsonl');

// Otros datos persistentes
export const AUDIT_REPORT_FILE = path.join(PERSISTENT_DATA_DIR, 'audit_report.json');
