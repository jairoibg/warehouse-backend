/**
 * Rutas para workflows y automatizaciones
 */

import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  executeWorkflow,
  getAvailableWorkflows,
  toggleWorkflow,
  startWorkflowScheduler
} from '../services/workflowService.js';

const router = express.Router();

/**
 * GET /api/workflows
 * Obtiene todos los workflows disponibles
 */
router.get('/', asyncHandler(async (req, res) => {
  const workflows = getAvailableWorkflows();
  res.json({
    success: true,
    workflows
  });
}));

/**
 * POST /api/workflows/:workflowName/execute
 * Ejecuta un workflow manualmente
 */
router.post('/:workflowName/execute', asyncHandler(async (req, res) => {
  const { workflowName } = req.params;
  const result = await executeWorkflow(workflowName);
  
  res.json({
    success: result.success,
    ...result
  });
}));

/**
 * PUT /api/workflows/:workflowName/toggle
 * Habilita/deshabilita un workflow
 */
router.put('/:workflowName/toggle', asyncHandler(async (req, res) => {
  const { workflowName } = req.params;
  const { enabled } = req.body;
  
  const result = toggleWorkflow(workflowName, enabled);
  res.json({
    success: true,
    ...result
  });
}));

/**
 * POST /api/workflows/scheduler/start
 * Inicia el programador de workflows
 */
router.post('/scheduler/start', asyncHandler(async (req, res) => {
  const result = startWorkflowScheduler();
  res.json({
    success: true,
    ...result
  });
}));

export default router;



